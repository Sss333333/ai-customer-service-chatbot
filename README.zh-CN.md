# AI 客户服务聊天机器人

[English](./README.md) | [简体中文](./README.zh-CN.md)

一个端到端的 AI 客服与售后支持平台，具备流式大模型对话、pgvector RAG 知识库检索、ERP 工具调用、实时语音输入输出以及人工客服接管控制台。

本文档只介绍项目功能。项目运行、部署、代理配置和各模块操作说明请查看前端与后端的 README。

## 功能

- **流式 AI 对话** — 基于 Vercel AI SDK 与 OpenRouter，支持多步工具调用，并在聊天界面流式输出。
- **RAG 知识库** — 使用 PostgreSQL + `pgvector` 与 Drizzle ORM，对已导入的产品/支持文档做语义检索。
- **ERP 工具** — 通过进程内 MCP 风格工具查询产品信息、订单状态、质保报障和客服工单。
- **实时语音** — DashScope Paraformer 流式 ASR、Edge TTS 语音播放，并支持AI回复过程中的打断。
- **人工客服接管控制台** — `/agent` 实时通话控制台，支持 AI 对话无缝转人工。客户与人工客服通过 WebSocket 进行双向实时语音通话，Gemini Live 在通话过程中即时翻译，双方可用各自语言交流，实现真正的跨语言实时通话，无需双方使用同一种语言。
- **附件上传** — 图片、视频和 PDF 通过 S3 预签名 URL 直传；本地开发可使用 Mock 模式。
- **双运行模式** — 后端既可以是本地 Node.js HTTP/WebSocket 服务，也可以部署为 AWS SAM Lambda 栈。

## 模块

| 目录 | 说明 | 文档 |
| --- | --- | --- |
| `Frontend/` | React 19 + Vite + Tailwind CSS 单页应用 | [English](./Frontend/README.md) · [中文](./Frontend/README.zh-CN.md) |
| `Backend/` | Node.js (ESM) 后端：聊天 API、语音 WebSocket、RAG、ERP 工具、AWS SAM 栈 | [English](./Backend/README.md) · [中文](./Backend/README.zh-CN.md) |

## 文档入口

- [前端：本地运行、Vite 代理、构建与静态部署](./Frontend/README.md)
- [后端：本地运行、RAG 导入、AWS 部署、代理与仓库同步](./Backend/README.md)

不要提交 `.env` 文件、API key、代理订阅或真实凭据。请以 `Backend/.env.example` 为模板；CI 需要的密钥请放在 CNB 密钥仓库中。
