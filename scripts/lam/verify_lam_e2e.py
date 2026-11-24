#!/usr/bin/env python3
"""End-to-end verification for AIChatBot LAM AvatarService."""
import asyncio
import json
import math
import struct

import aiohttp


def generate_pcm24k(duration_sec: float = 1.5, sr: int = 24000) -> bytes:
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
    session_id = "lam-e2e-test"

    async with aiohttp.ClientSession() as http:
        # 1. Check readiness, initconfig, and asset download
        async with http.get(f"{base_http}/readiness") as r:
            assert r.status == 200
            ready = await r.json()
            print("[CHECK 1] /readiness:", ready)

        async with http.get(f"{base_http}/lam/initconfig") as r:
            assert r.status == 200
            cfg = await r.json()
            assert len(cfg["arkitChannels"]) == 52
            print("[CHECK 2] /lam/initconfig:", cfg["assetUrl"], "channels=", len(cfg["arkitChannels"]))

        async with http.get(f"{base_http}{cfg['assetUrl']}") as r:
            assert r.status == 200
            data_bytes = await r.read()
            print("[CHECK 3] asset GET OK, bytes=", len(data_bytes))

        # 2. Connect browser WS + Node feed WS
        async with http.ws_connect(f"{base_ws}/ws/lam-client/{session_id}") as browser_ws:
            hello = await browser_ws.receive_json()
            assert hello["type"] == "ready"
            print("[BROWSER] ready:", hello["sessionId"])

            async with http.ws_connect(f"{base_ws}/ws/avatar-feed/{session_id}") as feed_ws:
                await feed_ws.send_json({"type": "speech_start", "speechId": f"{session_id}:1", "format": "pcm24k"})
                print("[FEED] start:", await feed_ws.receive_json())

                await feed_ws.send_bytes(generate_pcm24k(1.5))
                print("[FEED] audio:", await feed_ws.receive_json())

                await feed_ws.send_json({"type": "speech_end", "speechId": f"{session_id}:1"})
                print("[FEED] end:", await feed_ws.receive_json())

                chunks = 0
                got_end = False
                while not got_end:
                    msg = await asyncio.wait_for(browser_ws.receive(), timeout=15.0)
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        data = json.loads(msg.data)
                        if data["type"] == "speech_chunk":
                            bin_msg = await asyncio.wait_for(browser_ws.receive(), timeout=5.0)
                            assert bin_msg.type == aiohttp.WSMsgType.BINARY
                            assert len(data["frames"]) > 0 and len(data["frames"][0]) == 52
                            assert len(bin_msg.data) == data["audioSamples"] * 2
                            chunks += 1
                            print(
                                f"[BROWSER] chunk #{chunks}: {len(data['frames'])} ARKit frames, "
                                f"{data['audioSamples']} PCM samples"
                            )
                        elif data["type"] == "speech_end":
                            got_end = True
                            print("[BROWSER] speech_end received")

                assert chunks >= 2, f"Expected >=2 chunks for 1.5s audio, got {chunks}"

                # 3. Test interrupt
                await feed_ws.send_json({"type": "interrupt"})
                print("[FEED] interrupt:", await feed_ws.receive_json())
                int_msg = await asyncio.wait_for(browser_ws.receive_json(), timeout=5.0)
                assert int_msg["type"] == "interrupt"
                print("[BROWSER] interrupt received")

    print("\n=== LAM E2E VERIFICATION PASSED ===")


if __name__ == "__main__":
    asyncio.run(main())
