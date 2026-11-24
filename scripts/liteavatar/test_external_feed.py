#!/usr/bin/env python3
"""
Phase 1 verification script for ExternalAudioFeed -> LiteAvatar -> WebRTC.

Usage:
    # 1. Start AvatarService:
    #    uv run src/demo.py --config config/aichatbot_liteavatar.yaml
    # 2. Open http://localhost:8282/avatar-test and click "连接 WebRTC" (session_id=test1)
    # 3. Run this script:
    #    uv run scripts/test_external_feed.py --session test1 --tone
    #    uv run scripts/test_external_feed.py --session test1 --mp3 sample.mp3
    #    uv run scripts/test_external_feed.py --session test1 --mp3 sample.mp3 --interrupt-after 1.0
"""
import argparse
import asyncio
import json
import math
import struct
from pathlib import Path

import aiohttp


def generate_test_pcm24k(duration_sec: float = 2.5, sample_rate: int = 24000) -> bytes:
    total = int(duration_sec * sample_rate)
    out = bytearray(total * 2)
    for i in range(total):
        t = i / sample_rate
        env = 0.5 * (1.0 + math.sin(2.0 * math.pi * 3.0 * t))
        val = env * (
            0.4 * math.sin(2.0 * math.pi * 440.0 * t)
            + 0.25 * math.sin(2.0 * math.pi * 880.0 * t)
        )
        sample = max(-32767, min(32767, int(val * 32767)))
        struct.pack_into("<h", out, i * 2, sample)
    return bytes(out)


async def run_feed(args):
    ws_url = f"{args.url.rstrip('/')}/ws/avatar-feed/{args.session}"
    print(f"Connecting to {ws_url} ...")
    async with aiohttp.ClientSession() as http:
        async with http.ws_connect(ws_url) as ws:
            await ws.send_json({"type": "ping"})
            pong = await ws.receive_json()
            print("Ping reply:", pong)
            if not pong.get("sessionActive"):
                print(
                    f"[WARN] session '{args.session}' is not active yet. "
                    "Open http://localhost:8282/avatar-test and click '连接 WebRTC' first."
                )
                return

            if args.mp3:
                audio_bytes = Path(args.mp3).read_bytes()
                fmt = "mp3"
            else:
                audio_bytes = generate_test_pcm24k(args.duration)
                fmt = "pcm24k"

            speech_id = f"{args.session}:cli-test"
            await ws.send_json({"type": "speech_start", "speechId": speech_id, "format": fmt})
            print("speech_start ack:", await ws.receive_json())

            await ws.send_bytes(audio_bytes)
            print("audio ack:", await ws.receive_json())

            await ws.send_json({"type": "speech_end", "speechId": speech_id})
            print("speech_end ack:", await ws.receive_json())

            if args.interrupt_after > 0:
                print(f"Waiting {args.interrupt_after}s then sending interrupt...")
                await asyncio.sleep(args.interrupt_after)
                await ws.send_json({"type": "interrupt"})
                print("interrupt ack:", await ws.receive_json())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="ws://localhost:8282", help="AvatarService WS base URL")
    parser.add_argument("--session", default="test1", help="WebRTC session_id")
    parser.add_argument("--mp3", default="", help="Path to MP3/WAV file to feed")
    parser.add_argument("--tone", action="store_true", help="Send synthesized 24kHz PCM tone")
    parser.add_argument("--duration", type=float, default=2.5, help="Duration for --tone in seconds")
    parser.add_argument("--interrupt-after", type=float, default=0.0, help="Send interrupt after N seconds")
    args = parser.parse_args()
    asyncio.run(run_feed(args))


if __name__ == "__main__":
    main()
