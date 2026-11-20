# AI Customer Service Chatbot

An end-to-end AI customer service & after-sales support platform featuring streaming LLM conversations, pgvector RAG knowledge base retrieval, NetSuite ERP tool integration (via in-process MCP), real-time voice input/output (ASR & TTS), and a human agent handoff console.

## Architecture

- **`frontend/`** — React 19 + Vite + Tailwind CSS SPA
  - Streaming AI chat UI powered by `@ai-sdk/react` (`useChat`) and `streamdown`
  - Image/video attachment upload via pre-signed S3 URLs
  - Real-time voice input (WebSocket ASR) and auto-speak voice playback (WebSocket TTS with barge-in support)
  - Live human agent call & console (`/agent`)
- **`NewBackend/`** — Node.js (ESM) backend supporting both local HTTP/WebSocket server and AWS SAM Lambda deployment
  - **LLM & Tool Calling**: Vercel AI SDK + OpenRouter (`streamText` with multi-step tool execution)
  - **RAG Knowledge Base**: PostgreSQL + `pgvector` + Drizzle ORM (`NewBackend/src/rag` & `NewBackend/建立rag`)
  - **ERP Integration**: In-process `netsuite-mcp` layer for SuiteQL queries and Support Case creation (`get_product_info`, `check_order_status`, `start_warranty_claim`, `check_case_status`)
  - **Voice Pipeline**: DashScope Paraformer real-time ASR, Edge TTS streaming over WebSocket, and Gemini Live real-time voice translation for human calls

## Quick Start

### 1. Backend Setup

```bash
cd NewBackend
cp .env.example .env
# Fill in your API keys and database/ERP credentials in .env
npm install
npm run dev
```

The backend listens on `http://localhost:8080` by default.

### 2. Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

The frontend runs on `http://localhost:5173` and proxies API/WebSocket requests to the backend.

### 3. Optional: Seed RAG Knowledge Base

Configure `DATABASE_URL` (PostgreSQL with `pgvector` extension enabled) and `OPENROUTER_API_KEY` in `NewBackend/.env`, then run:

```bash
cd NewBackend
npm run db:seed
```

## Security Notes

- Never commit `.env` files or real API keys. Use `NewBackend/.env.example` as a template.
- NetSuite custom field identifiers in `NewBackend/src/tools/getProductInfo.js` and `NewBackend/src/services/netsuite.js` are placeholder names (`custitem_custom_*`, `custevent_case_evidence_link`); update them to match your NetSuite account schema before deploying.
