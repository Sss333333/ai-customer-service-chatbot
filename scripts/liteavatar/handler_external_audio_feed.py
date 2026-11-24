import io
import json
import threading
from pathlib import Path
from typing import Dict, Optional, cast

import av
import gradio
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from loguru import logger
from pydantic import BaseModel, Field
from starlette.websockets import WebSocketState

from chat_engine.common.handler_base import HandlerBaseInfo, HandlerDataInfo, HandlerDetail
from chat_engine.contexts.handler_context import HandlerContext
from chat_engine.contexts.session_context import SessionContext
from chat_engine.data_models.chat_data.chat_data_model import ChatData
from chat_engine.data_models.chat_data_type import ChatDataType
from chat_engine.data_models.chat_engine_config_data import (
    ChatEngineConfigModel,
    HandlerBaseConfigModel,
)
from chat_engine.data_models.chat_signal import ChatSignal
from chat_engine.data_models.chat_signal_type import ChatSignalSourceType, ChatSignalType
from chat_engine.data_models.chat_stream_config import ChatStreamConfig
from chat_engine.data_models.chat_stream_status import ChatStreamStatus
from chat_engine.data_models.runtime_data.data_bundle import (
    DataBundle,
    DataBundleDefinition,
    DataBundleEntry,
)
from handlers.manager.manager_handler_base import ManagerHandlerBase


class ExternalAudioFeedConfig(HandlerBaseConfigModel, BaseModel):
    sample_rate: int = Field(default=24000)
    ws_path_prefix: str = Field(default="/ws/avatar-feed")
    enable_test_page: bool = Field(default=True)


class ExternalAudioFeedContext(HandlerContext):
    def __init__(self, session_id: str):
        super().__init__(session_id)
        self.active_speech_id: Optional[str] = None
        self.audio_format: str = "mp3"
        self.lock = threading.Lock()


def decode_audio_to_float32_mono(payload: bytes, audio_format: str, target_sr: int = 24000) -> np.ndarray:
    """Decode incoming MP3/WAV/OGG/PCM bytes into 1D float32 mono waveform at target_sr."""
    if not payload:
        return np.zeros((0,), dtype=np.float32)

    fmt = (audio_format or "mp3").lower().strip()
    if fmt in ("pcm", "pcm24k", "pcm16", "s16le"):
        # Ensure even byte length for int16
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
                if rf is None:
                    continue
                arr = rf.to_ndarray()
                chunks.append(arr.reshape(-1).astype(np.float32, copy=False))
        # Flush resampler
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


class ExternalAudioFeedHandler(ManagerHandlerBase):
    """
    Accepts external audio (MP3 / PCM24k) + lifecycle/interrupt controls over WebSocket
    and injects ChatDataType.AVATAR_AUDIO directly into an active OpenAvatarChat session.
    """

    def __init__(self):
        super().__init__()
        self.config: ExternalAudioFeedConfig = ExternalAudioFeedConfig()
        self.audio_definition: Optional[DataBundleDefinition] = None
        self._contexts: Dict[str, ExternalAudioFeedContext] = {}
        self._contexts_lock = threading.Lock()
        self._routes_registered = False

    def get_handler_info(self) -> HandlerBaseInfo:
        return HandlerBaseInfo(
            name="ExternalAudioFeed",
            config_model=ExternalAudioFeedConfig,
        )

    def load(
        self,
        engine_config: ChatEngineConfigModel,
        handler_config: Optional[HandlerBaseConfigModel] = None,
    ):
        if isinstance(handler_config, ExternalAudioFeedConfig):
            self.config = handler_config
        definition = DataBundleDefinition()
        definition.add_entry(
            DataBundleEntry.create_audio_entry("avatar_audio", 1, self.config.sample_rate)
        )
        definition.lockdown()
        self.audio_definition = definition

    def create_context(
        self,
        session_context: SessionContext,
        handler_config: Optional[HandlerBaseConfigModel] = None,
    ) -> HandlerContext:
        session_id = session_context.session_info.session_id
        ctx = ExternalAudioFeedContext(session_id)
        with self._contexts_lock:
            self._contexts[session_id] = ctx
        logger.info(f"[ExternalAudioFeed] Context created for session_id={session_id}")
        return ctx

    def start_context(self, session_context: SessionContext, handler_context: HandlerContext):
        pass

    def get_handler_detail(
        self,
        session_context: SessionContext,
        context: HandlerContext,
    ) -> HandlerDetail:
        outputs = {
            ChatDataType.AVATAR_AUDIO: HandlerDataInfo(
                type=ChatDataType.AVATAR_AUDIO,
                definition=self.audio_definition,
                output_stream_config=ChatStreamConfig(cancelable=True, auto_link_input=False),
            )
        }
        return HandlerDetail(inputs={}, outputs=outputs)

    def handle(
        self,
        context: HandlerContext,
        inputs: ChatData,
        output_definitions: Dict[ChatDataType, HandlerDataInfo],
    ):
        # Producer-only handler; audio arrives via WebSocket endpoint.
        pass

    def destroy_context(self, context: HandlerContext):
        with self._contexts_lock:
            existing = self._contexts.get(context.session_id)
            if existing is context:
                self._contexts.pop(context.session_id, None)
        logger.info(f"[ExternalAudioFeed] Context destroyed for session_id={context.session_id}")

    def _get_context(self, session_id: str) -> Optional[ExternalAudioFeedContext]:
        with self._contexts_lock:
            return self._contexts.get(session_id)

    def _ensure_open_audio_stream(self, ctx: ExternalAudioFeedContext, speech_id: Optional[str] = None, force_new: bool = False):
        if ctx.data_submitter is None:
            return
        streamer = ctx.data_submitter.get_streamer(ChatDataType.AVATAR_AUDIO)
        if streamer is None:
            return
        current = streamer.current_stream
        need_new = (
            force_new
            or current is None
            or current.status in (ChatStreamStatus.CANCELLED, ChatStreamStatus.ENDED)
        )
        if need_new:
            if current is not None and current.status not in (
                ChatStreamStatus.CANCELLED,
                ChatStreamStatus.ENDED,
            ):
                streamer.finish_current()
            streamer.open_stream(name=speech_id or f"ext:{ctx.session_id}")

    def _submit_audio(self, ctx: ExternalAudioFeedContext, audio_1d: np.ndarray):
        if self.audio_definition is None or audio_1d.size == 0:
            return
        # Slice into <= 0.4s chunks so LiteAvatar's enable_fast_mode never receives >1s on the first packet
        max_chunk_samples = max(1, int(self.config.sample_rate * 0.4))
        with ctx.lock:
            self._ensure_open_audio_stream(ctx, ctx.active_speech_id, force_new=False)
            for offset in range(0, audio_1d.shape[0], max_chunk_samples):
                piece = audio_1d[offset : offset + max_chunk_samples]
                if piece.size == 0:
                    continue
                bundle = DataBundle(self.audio_definition)
                bundle.set_main_data(piece[np.newaxis, ...])
                ctx.submit_data(bundle, finish_stream=False)

    def _submit_speech_end(self, ctx: ExternalAudioFeedContext):
        if self.audio_definition is None:
            return
        with ctx.lock:
            if ctx.data_submitter is None:
                return
            streamer = ctx.data_submitter.get_streamer(ChatDataType.AVATAR_AUDIO)
            if streamer is None or streamer.current_stream is None:
                return
            if streamer.current_stream.status in (ChatStreamStatus.CANCELLED, ChatStreamStatus.ENDED):
                return
            tail = np.zeros((1, 240), dtype=np.float32)
            bundle = DataBundle(self.audio_definition)
            bundle.set_main_data(tail)
            ctx.submit_data(bundle, finish_stream=True)
            ctx.active_speech_id = None

    def _trigger_interrupt(self, ctx: ExternalAudioFeedContext):
        with ctx.lock:
            ctx.active_speech_id = None
            ctx.emit_signal(
                ChatSignal(
                    type=ChatSignalType.INTERRUPT,
                    source_type=ChatSignalSourceType.CLIENT,
                    source_name="ExternalAudioFeed",
                )
            )
            if ctx.data_submitter is not None:
                streamer = ctx.data_submitter.get_streamer(ChatDataType.AVATAR_AUDIO)
                if streamer is not None and streamer.current_stream is not None:
                    if streamer.current_stream.status not in (
                        ChatStreamStatus.CANCELLED,
                        ChatStreamStatus.ENDED,
                    ):
                        streamer.cancel_current()

    def on_setup_app(
        self,
        app: FastAPI,
        ui: gradio.blocks.Block,
        parent_block: Optional[gradio.blocks.Block] = None,
    ):
        if app is None or self._routes_registered:
            return
        self._routes_registered = True
        prefix = self.config.ws_path_prefix.rstrip("/")

        @app.get("/avatar-feed/sessions")
        async def list_avatar_sessions():
            with self._contexts_lock:
                sessions = list(self._contexts.keys())
            return JSONResponse({"sessions": sessions, "count": len(sessions)})

        if self.config.enable_test_page:
            test_page_path = Path(__file__).resolve().parent / "test_page.html"

            @app.get("/avatar-test")
            async def serve_avatar_test_page():
                if not test_page_path.exists():
                    return HTMLResponse("<h1>test_page.html not found</h1>", status_code=404)
                return HTMLResponse(test_page_path.read_text(encoding="utf-8"))

        @app.websocket(f"{prefix}/{{session_id}}")
        async def ws_avatar_feed(websocket: WebSocket, session_id: str):
            await websocket.accept()
            logger.info(f"[ExternalAudioFeed] WS connected: session_id={session_id}")
            current_format = "mp3"
            try:
                while True:
                    message = await websocket.receive()
                    msg_type = message.get("type")
                    if msg_type == "websocket.disconnect":
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
                                    "sessionActive": self._get_context(session_id) is not None,
                                }
                            )
                            continue

                        ctx = self._get_context(session_id)
                        if ctx is None:
                            await websocket.send_json(
                                {
                                    "type": "error",
                                    "code": "session_not_found",
                                    "message": f"No active WebRTC session for session_id={session_id}",
                                }
                            )
                            continue

                        if evt == "speech_start":
                            speech_id = payload.get("speechId") or f"{session_id}:speech"
                            current_format = payload.get("format") or "mp3"
                            with ctx.lock:
                                ctx.active_speech_id = speech_id
                                ctx.audio_format = current_format
                                self._ensure_open_audio_stream(ctx, speech_id, force_new=True)
                            await websocket.send_json(
                                {
                                    "type": "ack",
                                    "event": "speech_start",
                                    "speechId": speech_id,
                                    "format": current_format,
                                }
                            )
                        elif evt == "speech_end":
                            self._submit_speech_end(ctx)
                            await websocket.send_json(
                                {
                                    "type": "ack",
                                    "event": "speech_end",
                                    "speechId": payload.get("speechId"),
                                }
                            )
                        elif evt == "interrupt":
                            self._trigger_interrupt(ctx)
                            await websocket.send_json(
                                {"type": "ack", "event": "interrupt", "sessionId": session_id}
                            )
                        else:
                            await websocket.send_json(
                                {"type": "error", "message": f"Unknown event type: {evt}"}
                            )

                    elif message.get("bytes") is not None:
                        raw_bytes = message["bytes"]
                        ctx = self._get_context(session_id)
                        if ctx is None:
                            await websocket.send_json(
                                {
                                    "type": "error",
                                    "code": "session_not_found",
                                    "message": f"No active WebRTC session for session_id={session_id}",
                                }
                            )
                            continue

                        try:
                            audio_1d = decode_audio_to_float32_mono(
                                raw_bytes, current_format, self.config.sample_rate
                            )
                            self._submit_audio(ctx, audio_1d)
                            await websocket.send_json(
                                {
                                    "type": "ack",
                                    "event": "audio",
                                    "samples": int(audio_1d.shape[0]),
                                    "durationSec": round(
                                        float(audio_1d.shape[0]) / self.config.sample_rate, 3
                                    ),
                                }
                            )
                        except Exception as e:
                            logger.opt(exception=e).error(
                                f"[ExternalAudioFeed] Failed to decode/submit audio ({len(raw_bytes)} bytes)"
                            )
                            await websocket.send_json(
                                {"type": "error", "code": "decode_failed", "message": str(e)}
                            )
            except WebSocketDisconnect:
                logger.info(f"[ExternalAudioFeed] WS disconnected: session_id={session_id}")
            except Exception as e:
                logger.opt(exception=e).error(
                    f"[ExternalAudioFeed] WS error for session_id={session_id}: {e}"
                )
            finally:
                if websocket.client_state != WebSocketState.DISCONNECTED:
                    try:
                        await websocket.close()
                    except Exception:
                        pass

        logger.info(
            f"[ExternalAudioFeed] Routes registered: WS {prefix}/{{session_id}}, GET /avatar-feed/sessions, GET /avatar-test"
        )
