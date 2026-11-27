# Nova AI Customer Service — Backend

Node.js (ESM) backend powering **streaming multi-step LLM orchestration**, **in-process ONNX 3D digital human expression inference**, **Supabase `pgvector` RAG retrieval**, **in-process ERP MCP tools**, and **real-time voice WebSocket pipelines**.

---

## Architecture Modules

- **`src/ai/` — LLM & Multi-Step Tool Orchestration**
  - Built with Vercel AI SDK (`streamText` + `toUIMessageStream`) and OpenRouter, supporting reasoning streams and up to 5 sequential tool steps per turn.
  - Streams text deltas through a sentence splitter side-channel (`sentenceSplitter.js`) for low-latency TTS and 3D avatar lip-sync.
- **`src/avatar/` — In-Process LAM ONNX 3D Avatar Engine**
  - Runs `assets/lam/lam_audio2exp.onnx` locally via `onnxruntime-node` with bundled `ffmpeg` audio decoding, streaming 30fps 52-channel ARKit blendshape weights and 24kHz PCM audio over `/ws/lam-client/:sessionId`.
- **`src/rag/` — Supabase PostgreSQL + `pgvector` Knowledge Base**
  - Manages `resources` and `embeddings` tables via Drizzle ORM and performs semantic cosine-similarity recall across warranty SOPs.
- **`src/erp/` — ERP Integration Layer (`ERP MCP`)**
  - Token-authenticated ERP client supporting read/write role separation across `check_order_status`, `get_product_info`, `start_warranty_claim`, and `check_case_status`.
- **`src/audio/` — Real-Time Audio & Voice Translation Channels**
  - `/ws/asr` — DashScope Qwen streaming 16kHz PCM speech-to-text
  - `/ws/tts` — DashScope Qwen streaming speech synthesis fallback
  - `/ws/live-ai` — Gemini Live full-duplex voice call with barge-in and ERP tool calling
  - `/ws/human` — Bidirectional live voice translation (`EN ⇄ zh-Hans`) between the customer portal and `/agent`

---

## Local Development

```bash
cd Backend
cp .env.example .env   # Fill in API keys and database/ERP credentials
npm install

# Download LAM ONNX weights (if assets/lam/lam_audio2exp.onnx is missing)
npm run download:model

# Seed warranty SOP knowledge base vectors into Supabase PostgreSQL
npm run db:seed

# Start local HTTP + WebSocket dev server on http://localhost:8080
npm run dev

# Run tool integration tests
npm test
```

---

## AWS SAM Deployment (Serverless HTTP Mode)

`template.yaml` and `src/lambda.js` package stateless HTTP endpoints (`POST /chat`, `POST /upload-url`) and the attachments S3 bucket for AWS Lambda + API Gateway HTTP API (note: persistent WebSocket voice channels and in-process ONNX avatar streaming require running the stateful Node server via `npm start`):

```bash
cd Backend
sam build
sam deploy --guided
```
