# AI Customer Service Chatbot

[English](./README.md) | [简体中文](./README.zh-CN.md)

An end-to-end AI customer service and after-sales support platform with streaming LLM conversations, pgvector RAG retrieval, ERP tool calling, real-time voice input/output, and a human agent handoff console.

This document describes the product features. Setup, deployment, proxy configuration, and component-level operations are documented in the frontend and backend READMEs.

## Features

- **Streaming AI conversations** — Vercel AI SDK with OpenRouter, multi-step tool execution, and streamed responses in the chat UI.
- **RAG knowledge base** — PostgreSQL with `pgvector` and Drizzle ORM for semantic retrieval over seeded product/support documents.
- **ERP tools** — In-process MCP-style tools for product information, order status, warranty claims, and support case lookup.
- **Real-time voice** — DashScope Paraformer streaming ASR, Edge TTS playback, and barge-in support during AI replies.
- **Human agent handoff** — A live call console at `/agent` with Gemini Live real-time translation for cross-language support.
- **Attachments** — Image, video, and PDF upload through pre-signed S3 URLs, with a local mock mode for development.
- **Dual runtime** — The backend runs as a local Node.js HTTP/WebSocket server or as an AWS SAM Lambda stack.

## Components

| Directory | Description | Documentation |
| --- | --- | --- |
| `Frontend/` | React 19 + Vite + Tailwind CSS single-page application | [English](./Frontend/README.md) · [中文](./Frontend/README.zh-CN.md) |
| `Backend/` | Node.js (ESM) backend: chat API, WebSocket voice services, RAG, ERP tools, AWS SAM stack | [English](./Backend/README.md) · [中文](./Backend/README.zh-CN.md) |

## Documentation

- [Frontend: local development, Vite proxy, build and static deployment](./Frontend/README.md)
- [Backend: local development, RAG seeding, AWS deployment, proxy and repository sync](./Backend/README.md)

Never commit `.env` files, API keys, proxy subscriptions, or real credentials. Use `Backend/.env.example` as the template and keep secrets in a CNB secret repository when they are needed by CI.
