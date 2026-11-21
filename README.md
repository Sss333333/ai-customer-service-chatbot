# AI Customer Service Chatbot

An end-to-end AI customer service & after-sales support platform featuring streaming LLM conversations, pgvector RAG knowledge base retrieval, NetSuite ERP tool integration (via in-process MCP), real-time voice input/output (ASR & TTS), and a human agent handoff console.

## Architecture

- **`Frontend/`** — React 19 + Vite + Tailwind CSS SPA
  - Streaming AI chat UI powered by `@ai-sdk/react` (`useChat`) and `streamdown`
  - Image/video attachment upload via pre-signed S3 URLs
  - Real-time voice input (WebSocket ASR) and auto-speak voice playback (WebSocket TTS with barge-in support)
  - Live human agent call & console (`/agent`)
- **`Backend/`** — Node.js (ESM) backend supporting both local HTTP/WebSocket server and AWS SAM Lambda deployment
  - **LLM & Tool Calling**: Vercel AI SDK + OpenRouter (`streamText` with multi-step tool execution)
  - **RAG Knowledge Base**: PostgreSQL + `pgvector` + Drizzle ORM (`Backend/src/rag` & `Backend/建立rag`)
  - **ERP Integration**: In-process `netsuite-mcp` layer for SuiteQL queries and Support Case creation (`get_product_info`, `check_order_status`, `start_warranty_claim`, `check_case_status`)
  - **Voice Pipeline**: DashScope Paraformer real-time ASR, Edge TTS streaming over WebSocket, and Gemini Live real-time voice translation for human calls

## Quick Start

### 1. Backend Setup

```bash
cd Backend
cp .env.example .env
# Fill in your API keys and database/ERP credentials in .env
npm install
npm run dev
```

The backend listens on `http://localhost:8080` by default.

### 2. Frontend Setup

```bash
cd Frontend
npm install
npm run dev
```

The frontend runs on `http://localhost:5173` and proxies API/WebSocket requests to the backend.

### 3. Optional: Seed RAG Knowledge Base

Configure `DATABASE_URL` (PostgreSQL with `pgvector` extension enabled) and `OPENROUTER_API_KEY` in `Backend/.env`, then run:

```bash
cd Backend
npm run db:seed
```

## Security Notes

- Never commit `.env` files or real API keys. Use `Backend/.env.example` as a template.
- NetSuite custom field identifiers in `Backend/src/tools/getProductInfo.js` and `Backend/src/services/netsuite.js` are placeholder names (`custitem_custom_*`, `custevent_case_evidence_link`); update them to match your NetSuite account schema before deploying.

---

## 在 CNB 工作区中运行代理（中文说明）

人工通话里的 Gemini Live 实时翻译会按出口 IP 判断地区。如果工作区出口地区不受支持，WebSocket 会在握手阶段返回 `code=1007 User location is not supported for the API use.`。Windows 本地 Clash 的 `127.0.0.1:7890` 在 CNB 容器里指向容器自身，不能在容器中直接使用，因此采用“在容器内运行代理客户端”的方式。

当前代码已调整为：**只有显式配置 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 时才走代理**，不再默认使用 `http://127.0.0.1:7890`，避免出现 `ECONNREFUSED 127.0.0.1:7890`。

### 1. 下载 Clash Meta / Mihomo 内核

在 CNB 终端执行（架构按实际 `uname -m` 选择，当前环境为 `x86_64`）：

```bash
mkdir -p /workspace/proxy
cd /workspace/proxy
curl -L --fail -o mihomo.gz \
  https://github.com/MetaCubeX/mihomo/releases/download/v1.19.34/mihomo-linux-amd64-compatible-v1.19.34.gz
gunzip -f mihomo.gz
chmod +x mihomo
./mihomo -v
```

### 2. 放入节点配置

从本地 Clash 客户端导出配置，或使用订阅链接下载到 `/workspace/proxy/config.yaml`。注意不要提交该文件，也不要在聊天/工区公开订阅链接。

确保配置中包含 HTTP 代理端口，例如：

```yaml
mixed-port: 7890
```

校验配置：

```bash
cd /workspace/proxy
./mihomo -d . -t
```

### 3. 启动代理

前台启动：

```bash
cd /workspace/proxy
./mihomo -d .
```

后台启动：

```bash
cd /workspace/proxy
nohup ./mihomo -d . > mihomo.log 2>&1 &
```

看到类似日志即表示成功：

```
Mixed(http+socks) proxy listening at: [::]:7890
```

### 4. 选择 Gemini 支持的出口节点

如果配置里有多个节点，可以通过 Clash 的 RESTful API 切换节点组（假设 `external-controller: "127.0.0.1:9090"`）：

```bash
GROUP=$(node -e "process.stdout.write(encodeURIComponent('🚀 节点选择'))")
curl -sS -X PUT "http://127.0.0.1:9090/proxies/$GROUP" \
  -H 'Content-Type: application/json' \
  -d '{"name":"🇺🇲 美国 01"}'
```

验证出口地区：

```bash
curl -x http://127.0.0.1:7890 https://ipinfo.io/json
```

返回的 `country` 必须是 Gemini Live 支持的地区。香港节点实测仍会触发 `1007`，美国节点实测可完成握手。

### 5. 让后端使用代理

在 `Backend/.env` 中启用：

```env
HTTPS_PROXY=http://127.0.0.1:7890
```

然后重启后端，使 `dotenv` 重新加载配置：

```bash
cd /workspace/Backend
npm run dev
```

最后刷新前端页面，重新进入人工通话/实时翻译即可。

### 6. 安全与持久化

- `Backend/.env` 已由 `.env` 规则忽略。
- 整个 `proxy/` 目录已加入 `.gitignore`，包括 `config.yaml`、`config.example.yaml`、内核和日志，避免提交 API key 或代理订阅信息。
- 如果这些文件曾经提交过，需要立即轮换 API key / 订阅链接并清理 git 历史。
- CNB 工作区重启后，后台运行的 `mihomo` 不会自动恢复，需要按第 3 步重新启动。

### 7. 新环境一键恢复（文件漫游）

CNB 云开发环境在闲置销毁后重建时，`.gitignore` 忽略的文件**不会进入代码备份**，所以 `proxy/` 和 `Backend/.env` 都不会自动恢复。推荐把敏感文件放到 CNB 文件漫游目录，再用仓库里的脚本一键恢复。

1. 在 **个人设置 → 云原生开发** 的自定义漫游路径中加入：

```text
/root/.cnb
/root/.cnb/*
```

2. 把敏感文件保存到漫游目录（不要放进 git）：

```text
/root/.cnb/proxy-config.yaml    # Clash / Mihomo 订阅配置
/root/.cnb/backend.env          # 只写需要恢复的 KEY=VALUE
```

`backend.env` 示例（不要填真实值到 README 或提交到仓库）：

```env
OPENROUTER_API_KEY=your-openrouter-api-key
GEMINI_API_KEY=your-gemini-api-key
DASHSCOPE_API_KEY=your-dashscope-api-key
DATABASE_URL=postgresql://user:password@host:5432/db
```

3. 新环境启动后执行一键脚本：

```bash
bash /workspace/scripts/setup-proxy.sh
```

脚本会自动完成：

- 下载 `mihomo` 内核（若不存在）
- 从漫游目录复制代理配置并校验
- 创建/补齐 `Backend/.env`
- 启用 `HTTPS_PROXY=http://127.0.0.1:7890`
- 后台启动 `mihomo` 并打印出口 IP

4. 在另一个终端重启后端：

```bash
cd /workspace/Backend
npm run dev
```

注意：不要用 `kill 1` 关闭开发环境，否则漫游不会保存；同时打开多个环境时，后销毁的环境漫游内容会覆盖先销毁的环境。
