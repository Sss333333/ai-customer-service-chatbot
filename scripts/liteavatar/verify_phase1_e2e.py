#!/usr/bin/env python3
"""
Automated Phase 1 end-to-end verification:
  1. WebRTC handshake (POST /webrtc/offer with webrtc_id=phase1-verify)
  2. Confirm video frames arrive from LiteAvatar
  3. Feed 24kHz PCM audio via WS /ws/avatar-feed/phase1-verify -> confirm stream_begin & stream_end
  4. Feed 4s audio then send interrupt -> confirm stream_cancel
"""
import asyncio
import json
import math
import struct
import time

import aiohttp
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.mediastreams import AudioStreamTrack, VideoStreamTrack


def generate_pcm24k(duration_sec: float = 2.0, sr: int = 24000) -> bytes:
    total = int(duration_sec * sr)
    buf = bytearray(total * 2)
    for i in range(total):
        t = i / sr
        env = 0.5 * (1.0 + math.sin(2.0 * math.pi * 3.0 * t))
        val = env * (0.4 * math.sin(2.0 * math.pi * 440.0 * t))
        struct.pack_into("<h", buf, i * 2, max(-32767, min(32767, int(val * 32767))))
    return bytes(buf)


async def main():
    base_http = "http://127.0.0.1:8282"
    base_ws = "ws://127.0.0.1:8282"
    session_id = "phase1-verify"

    pc = RTCPeerConnection()
    dc = pc.createDataChannel("text")

    signals = []
    video_frames = 0
    video_size = None
    audio_frames = 0
    track_tasks = []

    @dc.on("message")
    def on_dc_msg(msg):
        try:
            parsed = json.loads(msg)
        except Exception:
            return
        if parsed.get("header", {}).get("name") == "ChatSignal":
            sig = parsed.get("payload", {}).get("type")
            stype = parsed.get("payload", {}).get("stream_type")
            print(f"[DC] ChatSignal: stream_type={stype}, type={sig}")
            if stype == "client_playback":
                signals.append(sig)

    @pc.on("track")
    def on_track(track):
        print(f"[RTC] Received remote track: {track.kind}")

        async def consume():
            nonlocal video_frames, video_size, audio_frames
            try:
                while True:
                    frame = await track.recv()
                    if track.kind == "video":
                        video_frames += 1
                        if video_size is None:
                            video_size = (frame.width, frame.height)
                    else:
                        audio_frames += 1
            except Exception:
                pass

        track_tasks.append(asyncio.create_task(consume()))

    # fastrtc send-receive mode triggers stream start_up when client sends audio/video tracks
    pc.addTrack(VideoStreamTrack())
    pc.addTrack(AudioStreamTrack())

    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    # Wait briefly for ICE gathering
    t0 = time.time()
    while pc.iceGatheringState != "complete" and time.time() - t0 < 3.0:
        await asyncio.sleep(0.05)

    async with aiohttp.ClientSession() as http:
        async with http.post(
            f"{base_http}/webrtc/offer",
            json={
                "sdp": pc.localDescription.sdp,
                "type": pc.localDescription.type,
                "webrtc_id": session_id,
            },
        ) as resp:
            assert resp.status == 200, f"Offer failed: {resp.status} {await resp.text()}"
            answer = await resp.json()
            await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type=answer["type"]))

        # Wait for session to register & first video frames
        for _ in range(40):
            async with http.get(f"{base_http}/avatar-feed/sessions") as sresp:
                sdata = await sresp.json()
                if session_id in sdata.get("sessions", []) and video_frames >= 5:
                    break
            await asyncio.sleep(0.25)

        print(f"[CHECK 1] Active sessions={sdata}, video_frames={video_frames}, video_size={video_size}, audio_frames={audio_frames}")
        assert session_id in sdata.get("sessions", []), "Session not registered in ExternalAudioFeed!"
        assert video_frames >= 1, "No video frames received from LiteAvatar!"

        # Connect Feed WS and send 1.5s audio
        async with http.ws_connect(f"{base_ws}/ws/avatar-feed/{session_id}") as ws:
            await ws.send_json({"type": "speech_start", "speechId": f"{session_id}:1", "format": "pcm24k"})
            print("[WS] speech_start:", await ws.receive_json())
            await ws.send_bytes(generate_pcm24k(1.5))
            print("[WS] audio:", await ws.receive_json())
            await ws.send_json({"type": "speech_end", "speechId": f"{session_id}:1"})
            print("[WS] speech_end:", await ws.receive_json())

            # Wait up to 20s for stream_begin and stream_end (CPU encoding is slower than real-time at 1920p)
            for _ in range(200):
                if "stream_begin" in signals and "stream_end" in signals:
                    break
                await asyncio.sleep(0.1)

            print(f"[CHECK 2] Signals after speech 1: {signals}, video_frames={video_frames}")
            assert "stream_begin" in signals, "Missing stream_begin signal!"
            assert "stream_end" in signals, "Missing stream_end signal!"

            # Now test interrupt mid-speech
            signals.clear()
            await ws.send_json({"type": "speech_start", "speechId": f"{session_id}:2", "format": "pcm24k"})
            await ws.receive_json()
            await ws.send_bytes(generate_pcm24k(4.0))
            await ws.receive_json()
            await ws.send_json({"type": "speech_end", "speechId": f"{session_id}:2"})
            await ws.receive_json()

            # Wait for stream_begin then interrupt
            for _ in range(40):
                if "stream_begin" in signals:
                    break
                await asyncio.sleep(0.1)

            await ws.send_json({"type": "interrupt"})
            print("[WS] interrupt:", await ws.receive_json())

            for _ in range(40):
                if "stream_cancel" in signals:
                    break
                await asyncio.sleep(0.1)

            print(f"[CHECK 3] Signals after interrupt: {signals}, total video_frames={video_frames}")
            assert "stream_cancel" in signals, "Missing stream_cancel signal after interrupt!"

    for t in track_tasks:
        t.cancel()
    await pc.close()
    print("\n=== PHASE 1 E2E VERIFICATION PASSED ===")


if __name__ == "__main__":
    asyncio.run(main())
