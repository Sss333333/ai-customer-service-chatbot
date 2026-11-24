#!/usr/bin/env python3
"""
Lightweight LAM (3D Gaussian Splatting) Audio2Expression Server for AIChatBot.

Architecture:
  - Zero idle CPU: browser renders 3DGS locally via gaussian-splat-renderer-for-lam
  - Shared single LAM_Audio2Expression model across all concurrent sessions
  - Node.js Backend pushes MP3/PCM24k over WS /ws/avatar-feed/{session_id}
    (100% compatible with Backend/src/audio/avatarBridge.js)
  - Browser connects over WS /ws/lam-client/{session_id} and receives synchronized
    (52-dim ARKit blendshapes @ 30fps + 24kHz int16 PCM audio)
"""
import argparse
import asyncio
import io
import json
import os
import re
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

import av
import numpy as np
import torch
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from loguru import logger
from starlette.websockets import WebSocketState

# Ensure AvatarService/src and LAM_Audio2Expression are importable
SERVICE_ROOT = Path(__file__).resolve().parent.parent
SRC_ROOT = SERVICE_ROOT / "src"
LAM_HANDLER_ROOT = SRC_ROOT / "handlers" / "avatar" / "lam"
LAM_ALGO_ROOT = LAM_HANDLER_ROOT / "LAM_Audio2Expression"
LAM_SAMPLES_DIR = SRC_ROOT / "handlers" / "client" / "ws_lam_client" / "lam_samples"

for p in (str(SRC_ROOT), str(LAM_ALGO_ROOT)):
    if p not in sys.path:
        sys.path.insert(0, p)

SAMPLE_RATE = 24000
FPS = 30


def decode_audio_to_float32_mono(payload: bytes, audio_format: str, target_sr: int = SAMPLE_RATE) -> np.ndarray:
    """Decode incoming MP3/WAV/OGG/PCM bytes into 1D float32 mono waveform at target_sr."""
    if not payload:
        return np.zeros((0,), dtype=np.float32)

    fmt = (audio_format or "mp3").lower().strip()
    if fmt in ("pcm", "pcm24k", "pcm16", "s16le"):
        usable = len(payload) - (len(payload) % 2)
        if usable <= 0:
            return np.zeros((0,), dtype=np.float32)
        pcm = np.frombuffer(payload[:usable], dtype=np.int16)
        return (pcm.astype(np.float32) / 32768.0).reshape(-1)

    resampler = av.AudioResampler(format="flt", layout="mono", rate=target_sr)
    chunks = []
    with av.open(io.BytesIO(payload), mode="r") as container:
        audio_streams = [s for s in container.streams if s.type == "audio"]
        if not audio_streams:
            return np.zeros((0,), dtype=np.float32)
        stream = audio_streams[0]
        for frame in container.decode(stream):
            resampled_frames = resampler.resample(frame)
            if not isinstance(resampled_frames, list):
                resampled_frames = [resampled_frames]
            for rf in resampled_frames:
                if rf is not None:
                    chunks.append(rf.to_ndarray().reshape(-1).astype(np.float32, copy=False))
        flushed = resampler.resample(None)
        if flushed:
            if not isinstance(flushed, list):
                flushed = [flushed]
            for rf in flushed:
                if rf is not None:
                    chunks.append(rf.to_ndarray().reshape(-1).astype(np.float32, copy=False))

    if not chunks:
        return np.zeros((0,), dtype=np.float32)
    return np.concatenate(chunks, axis=0)


class LamInferenceEngine:
    def __init__(self, model_root: Path):
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.infer = None
        self.arkit_channels: List[str] = []
        self._lock = threading.Lock()
        self._load(model_root)

    def _load(self, model_root: Path):
        from engines.defaults import default_config_parser, default_setup
        from engines.infer import INFER

        weight_path = (model_root / "LAM_audio2exp" / "pretrained_models" / "lam_audio2exp_streaming.tar").as_posix()
        wav2vec_path = (model_root / "wav2vec2-base-960h").as_posix()
        config_file = (LAM_ALGO_ROOT / "configs" / "lam_audio2exp_config_streaming.py").as_posix()
        wav2vec_config_file = (LAM_ALGO_ROOT / "configs" / "wav2vec2_config.json").as_posix()

        if not os.path.isfile(weight_path):
            raise FileNotFoundError(f"LAM weight not found: {weight_path}")
        if not os.path.isdir(wav2vec_path):
            raise FileNotFoundError(f"wav2vec2 model dir not found: {wav2vec_path}")

        cfg = default_config_parser(
            config_file,
            {
                "weight": weight_path,
                "model": {
                    "backbone": {
                        "pretrained_encoder_path": wav2vec_path,
                        "wav2vec2_config_path": wav2vec_config_file,
                    }
                },
            },
        )
        cfg = default_setup(cfg)
        self.infer = INFER.build(dict(type=cfg.infer.type, cfg=cfg))
        self.infer.model.eval()

        arkit_path = LAM_HANDLER_ROOT / "assets" / "arkit_face_channels.txt"
        self.arkit_channels = [
            line.strip() for line in arkit_path.read_text(encoding="utf-8").splitlines() if line.strip()
        ]

        t0 = time.monotonic()
        self.infer.infer_streaming_audio(
            context=None,
            audio=np.zeros([SAMPLE_RATE], dtype=np.float32),
            ssr=SAMPLE_RATE,
        )
        logger.info(
            f"[LAM] Model loaded on {self.device} and warmed up in {(time.monotonic() - t0) * 1000:.0f}ms "
            f"({len(self.arkit_channels)} ARKit channels)"
        )

    def infer_chunk(self, audio_1d: np.ndarray, context: Optional[dict]):
        with self._lock:
            result, next_ctx = self.infer.infer_streaming_audio(
                audio=audio_1d.astype(np.float32, copy=False),
                ssr=SAMPLE_RATE,
                context=context,
            )
        exp = result.get("expression")
        if exp is None:
            n_frames = max(1, round(len(audio_1d) / SAMPLE_RATE * FPS))
            exp = np.zeros((n_frames, len(self.arkit_channels)), dtype=np.float32)
        else:
            exp = np.asarray(exp, dtype=np.float32)
        return exp, next_ctx


@dataclass
class LamClientSession:
    session_id: str
    client_ws: WebSocket
    turn_id: int = 0
    active_speech_id: Optional[str] = None
    infer_context: Optional[dict] = None
    pending_audio: np.ndarray = field(default_factory=lambda: np.zeros((0,), dtype=np.float32))
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def create_app(engine: LamInferenceEngine, asset_name: str = "status.zip") -> FastAPI:
    app = FastAPI(title="AIChatBot LAM Avatar Service")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    sessions: Dict[str, LamClientSession] = {}

    async def safe_send_json(session: LamClientSession, payload: dict) -> bool:
        if session.client_ws.client_state != WebSocketState.CONNECTED:
            return False
        try:
            async with session.send_lock:
                await session.client_ws.send_json(payload)
            return True
        except Exception as e:
            logger.warning(f"[LAM] Failed to send JSON to {session.session_id}: {e}")
            return False

    async def safe_send_chunk(
        session: LamClientSession,
        speech_id: str,
        frames: np.ndarray,
        audio_1d: np.ndarray,
    ) -> bool:
        if session.client_ws.client_state != WebSocketState.CONNECTED:
            return False
        pcm_int16 = np.clip(audio_1d * 32767.0, -32768, 32767).astype(np.int16)
        # Round blendshape floats to 4 decimals to keep JSON compact
        frames_list = np.round(frames, 4).tolist()
        meta = {
            "type": "speech_chunk",
            "speechId": speech_id,
            "fps": FPS,
            "sampleRate": SAMPLE_RATE,
            "audioSamples": int(pcm_int16.shape[0]),
            "frames": frames_list,
        }
        try:
            async with session.send_lock:
                await session.client_ws.send_json(meta)
                await session.client_ws.send_bytes(pcm_int16.tobytes())
            return True
        except Exception as e:
            logger.warning(f"[LAM] Failed to send chunk to {session.session_id}: {e}")
            return False

    async def process_and_emit(session: LamClientSession, audio_1d: np.ndarray, is_final: bool, expected_turn: int):
        if session.turn_id != expected_turn:
            return
        if audio_1d.size > 0:
            session.pending_audio = np.concatenate([session.pending_audio, audio_1d], axis=0)

        # Process in 1.0s slices for smooth streaming (matching OpenAvatarChat's LAM handler)
        slice_samples = SAMPLE_RATE
        segments: List[np.ndarray] = []
        while session.pending_audio.shape[0] >= slice_samples:
            segments.append(session.pending_audio[:slice_samples])
            session.pending_audio = session.pending_audio[slice_samples:]

        if is_final and session.pending_audio.shape[0] > 0:
            segments.append(session.pending_audio)
            session.pending_audio = np.zeros((0,), dtype=np.float32)

        for seg in segments:
            if session.turn_id != expected_turn:
                return
            t0 = time.monotonic()
            frames, next_ctx = await asyncio.to_thread(engine.infer_chunk, seg, session.infer_context)
            if session.turn_id != expected_turn:
                return
            session.infer_context = next_ctx
            dur_ms = (time.monotonic() - t0) * 1000
            logger.info(
                f"[LAM] session={session.session_id} inferred {frames.shape[0]} frames "
                f"for {seg.shape[0] / SAMPLE_RATE:.2f}s audio in {dur_ms:.0f}ms"
            )
            await safe_send_chunk(
                session,
                session.active_speech_id or f"{session.session_id}:{expected_turn}",
                frames,
                seg,
            )

        if is_final and session.turn_id == expected_turn:
            session.infer_context = None
            await safe_send_json(
                session,
                {"type": "speech_end", "speechId": session.active_speech_id},
            )

    @app.get("/readiness")
    async def readiness():
        return JSONResponse(
            {
                "status": "ok",
                "mode": "lam",
                "device": str(engine.device),
                "asset": asset_name,
                "activeSessions": len(sessions),
            }
        )

    @app.get("/lam/initconfig")
    async def lam_initconfig():
        return JSONResponse(
            {
                "mode": "lam",
                "assetUrl": f"/lam/asset/{asset_name}",
                "wsPath": "/ws/lam-client",
                "fps": FPS,
                "sampleRate": SAMPLE_RATE,
                "arkitChannels": engine.arkit_channels,
            }
        )

    @app.get("/lam/asset/{file_name}")
    async def get_lam_asset(file_name: str):
        if not re.match(r"^[a-zA-Z0-9._-]+$", file_name):
            return JSONResponse(status_code=400, content={"error": "Invalid file name"})
        file_path = (LAM_SAMPLES_DIR / file_name).resolve()
        if not str(file_path).startswith(str(LAM_SAMPLES_DIR.resolve())) or not file_path.is_file():
            return JSONResponse(status_code=404, content={"error": "Asset not found"})
        return FileResponse(
            str(file_path),
            headers={"Cache-Control": "public, max-age=86400"},
        )

    @app.get("/avatar-feed/sessions")
    async def list_sessions():
        return JSONResponse({"sessions": list(sessions.keys()), "count": len(sessions)})

    @app.websocket("/ws/lam-client/{session_id}")
    async def ws_lam_client(websocket: WebSocket, session_id: str):
        await websocket.accept()
        prev = sessions.get(session_id)
        if prev is not None:
            prev.turn_id += 1
            try:
                await prev.client_ws.close(code=1000, reason="Replaced by newer connection")
            except Exception:
                pass

        session = LamClientSession(session_id=session_id, client_ws=websocket)
        sessions[session_id] = session
        logger.info(f"[LAM] Browser client connected: session_id={session_id} (total={len(sessions)})")
        await safe_send_json(
            session,
            {
                "type": "ready",
                "sessionId": session_id,
                "fps": FPS,
                "sampleRate": SAMPLE_RATE,
                "arkitChannels": engine.arkit_channels,
            },
        )
        try:
            while True:
                raw = await websocket.receive_text()
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                evt = msg.get("type")
                if evt == "ping":
                    await safe_send_json(session, {"type": "pong"})
                elif evt == "interrupt":
                    session.turn_id += 1
                    session.infer_context = None
                    session.pending_audio = np.zeros((0,), dtype=np.float32)
                    await safe_send_json(session, {"type": "interrupt"})
        except WebSocketDisconnect:
            logger.info(f"[LAM] Browser client disconnected: session_id={session_id}")
        except Exception as e:
            logger.warning(f"[LAM] Browser WS error ({session_id}): {e}")
        finally:
            if sessions.get(session_id) is session:
                session.turn_id += 1
                sessions.pop(session_id, None)

    @app.websocket("/ws/avatar-feed/{session_id}")
    async def ws_avatar_feed(websocket: WebSocket, session_id: str):
        await websocket.accept()
        logger.info(f"[LAM-Feed] Node bridge connected: session_id={session_id}")
        current_format = "mp3"
        try:
            while True:
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    break

                if message.get("text") is not None:
                    try:
                        payload = json.loads(message["text"])
                    except Exception:
                        await websocket.send_json({"type": "error", "message": "Invalid JSON"})
                        continue

                    evt = payload.get("type")
                    if evt == "ping":
                        await websocket.send_json(
                            {
                                "type": "pong",
                                "sessionId": session_id,
                                "sessionActive": session_id in sessions,
                            }
                        )
                        continue

                    session = sessions.get(session_id)
                    if session is None:
                        await websocket.send_json(
                            {
                                "type": "error",
                                "code": "session_not_found",
                                "message": f"No active LAM browser session for session_id={session_id}",
                            }
                        )
                        continue

                    if evt == "speech_start":
                        session.turn_id += 1
                        session.active_speech_id = payload.get("speechId") or f"{session_id}:{session.turn_id}"
                        session.infer_context = None
                        session.pending_audio = np.zeros((0,), dtype=np.float32)
                        current_format = payload.get("format") or "mp3"
                        await websocket.send_json(
                            {
                                "type": "ack",
                                "event": "speech_start",
                                "speechId": session.active_speech_id,
                                "format": current_format,
                            }
                        )
                    elif evt == "speech_end":
                        expected_turn = session.turn_id
                        await process_and_emit(
                            session,
                            np.zeros((0,), dtype=np.float32),
                            is_final=True,
                            expected_turn=expected_turn,
                        )
                        await websocket.send_json(
                            {"type": "ack", "event": "speech_end", "speechId": payload.get("speechId")}
                        )
                    elif evt == "interrupt":
                        session.turn_id += 1
                        session.infer_context = None
                        session.pending_audio = np.zeros((0,), dtype=np.float32)
                        await safe_send_json(session, {"type": "interrupt"})
                        await websocket.send_json(
                            {"type": "ack", "event": "interrupt", "sessionId": session_id}
                        )
                    else:
                        await websocket.send_json({"type": "error", "message": f"Unknown event: {evt}"})

                elif message.get("bytes") is not None:
                    raw_bytes = message["bytes"]
                    session = sessions.get(session_id)
                    if session is None:
                        await websocket.send_json(
                            {
                                "type": "error",
                                "code": "session_not_found",
                                "message": f"No active LAM browser session for session_id={session_id}",
                            }
                        )
                        continue

                    try:
                        expected_turn = session.turn_id
                        audio_1d = decode_audio_to_float32_mono(raw_bytes, current_format, SAMPLE_RATE)
                        await process_and_emit(session, audio_1d, is_final=False, expected_turn=expected_turn)
                        await websocket.send_json(
                            {
                                "type": "ack",
                                "event": "audio",
                                "samples": int(audio_1d.shape[0]),
                                "durationSec": round(float(audio_1d.shape[0]) / SAMPLE_RATE, 3),
                            }
                        )
                    except Exception as e:
                        logger.opt(exception=e).error(f"[LAM-Feed] Failed to process audio: {e}")
                        await websocket.send_json(
                            {"type": "error", "code": "decode_failed", "message": str(e)}
                        )
        except WebSocketDisconnect:
            logger.info(f"[LAM-Feed] Node bridge disconnected: session_id={session_id}")
        finally:
            if websocket.client_state != WebSocketState.DISCONNECTED:
                try:
                    await websocket.close()
                except Exception:
                    pass

    return app


def main():
    parser = argparse.ArgumentParser(description="AIChatBot Lightweight LAM Avatar Service")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8282)
    parser.add_argument("--asset", default="status.zip", help="Asset zip inside lam_samples/")
    parser.add_argument("--model-root", default="models", help="Model root directory")
    args = parser.parse_args()

    model_root = Path(args.model_root)
    if not model_root.is_absolute():
        model_root = SERVICE_ROOT / model_root

    engine = LamInferenceEngine(model_root)
    app = create_app(engine, asset_name=args.asset)
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
