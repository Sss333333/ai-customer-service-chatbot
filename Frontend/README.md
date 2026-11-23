# AI Customer Service Frontend

[English](./README.md) | [简体中文](./README.zh-CN.md)

React 19 + Vite + Tailwind CSS single-page application for the AI customer service chatbot. Product features are listed in the [root README](../README.md).

## Requirements

- Node.js 20.x
- A running backend (see the [Backend README](../Backend/README.md))

## Local Development

```bash
cd Frontend
npm install
npm run dev
```

The dev server runs at `http://localhost:5173`.

Keep `VITE_API_BASE` unset during local development so requests use the Vite dev proxy described below.

## Development Proxy

`vite.config.js` proxies backend requests to `http://localhost:8080`:

| Path | Target | WebSocket |
| --- | --- | --- |
| `/chat` | `http://localhost:8080` | No |
| `/upload-url` | `http://localhost:8080` | No |
| `/api` | `http://localhost:8080` | Yes |
| `/ws` | `http://localhost:8080` | Yes |

This covers chat streaming, attachment uploads, audio transcription, ASR, TTS, and human-call WebSockets. `allowedHosts` currently includes the CNB preview host `5wqv5khjzb-5173.cnb.run`; add your own preview domain there if you use a different one.

If the frontend is served from a different origin than the backend, set `VITE_API_BASE` to the backend origin at build time. The WebSocket hooks derive their URLs from this value, for example `VITE_API_BASE=https://api.example.com` results in `wss://api.example.com/ws/asr`.

## Build

```bash
cd Frontend
npm run build
npm run preview
```

`npm run build` writes the static assets to `dist/`. `npm run preview` serves that directory locally.

## Deployment

The frontend is a static SPA and can be hosted on any static file service or CDN.

1. Build with `npm run build`.
2. Publish the contents of `dist/`.
3. Configure an SPA fallback so unknown routes such as `/agent` return `index.html`.
4. If the backend is on another origin, set `VITE_API_BASE` before building and make sure the backend `PUBLIC_FRONTEND_URL` and CORS settings allow the frontend origin.
5. Ensure the CDN or ingress forwards WebSocket upgrade requests for `/ws/*` and `/api/*` paths.

Do not put API keys in frontend environment variables; all secrets belong in the backend or in a CNB secret repository.
