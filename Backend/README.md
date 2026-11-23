# AI Customer Service Backend (`warranty-node`)

[English](./README.md) | [简体中文](./README.zh-CN.md)

Node.js (ESM) backend for the AI customer service chatbot. It provides the chat API, WebSocket voice services, pgvector RAG retrieval, ERP tools, and an AWS SAM deployment stack. Product features are listed in the [root README](../README.md).

## Requirements

- Node.js 20.x
- PostgreSQL with the `pgvector` extension enabled (required for RAG)
- AWS credentials and an S3 bucket, or `LOCAL_DEV_MOCK_S3=true` for local development
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) for deployment

## Local Development

```bash
cd Backend
cp .env.example .env
# Fill in the required values in .env (see Configuration below)
npm install
npm run dev
```

The server listens on `http://localhost:8080` by default.

| Endpoint | Description |
| --- | --- |
| `POST /chat` | Streaming chat and tool-calling API |
| `POST /upload-url` | Pre-signed S3 PUT URL for attachments |
| `GET /health` | Service and model health check |
| `WS /ws/asr` | DashScope real-time speech recognition |
| `WS /ws/tts` | Edge TTS streaming playback |
| `WS /ws/human` | Human agent call with Gemini Live translation |

Available scripts:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start with `node --watch` |
| `npm start` | Start once without watch mode |
| `npm test` | Run backend tool tests |
| `npm run db:seed` | Seed the RAG knowledge base |
| `npm run rag:test` | Run RAG retrieval checks |

## Configuration

Start from `Backend/.env.example`. The main groups are:

- **Server**: `PORT`, `PUBLIC_FRONTEND_URL`, `CHAT_DEADLINE_MS`
- **LLM**: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_EMBEDDING_MODEL`
- **RAG**: `DATABASE_URL`
- **Storage**: `S3_BUCKET_NAME`, `AWS_REGION`, `LOCAL_DEV_MOCK_S3`
- **Voice**: `DASHSCOPE_API_KEY`, `DASHSCOPE_ASR_MODEL`, `DEFAULT_TTS_VOICE`, `GEMINI_API_KEY`
- **ERP**: credentials, case form ID, stock script IDs, defaults
- **Proxy**: `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` (optional, see [Proxy](#proxy-cnb-workspace--gemini-live))

`CHAT_DEADLINE_MS` defaults to `25000`. Keep it below the Lambda timeout (`29s` in `template.yaml`) and the API Gateway limit (`30s`).

Custom field identifiers in the ERP integration code (`Backend/src/tools/` and `Backend/src/services/`) are placeholders such as `custitem_custom_*` and `custevent_case_evidence_link`. Update them to match your ERP account schema before using ERP tools in production.

## RAG Knowledge Base

Set `DATABASE_URL` to a PostgreSQL instance with `pgvector` installed, set `OPENROUTER_API_KEY`, then seed the documents:

```bash
cd Backend
npm run db:seed
```

Use `npm run rag:test` to verify retrieval.

## AWS Deployment

The SAM stack is named `warranty-node` and targets `ap-southeast-2` via `samconfig.toml`.

```bash
cd Backend

# First deployment
sam build
sam deploy --guided

# Later deployments
sam deploy
```

The stack creates:

1. `HttpApi` — API Gateway v2 with CORS enabled
2. `WarrantyFunction` — Node.js 20.x / arm64 Lambda with S3 permissions and a 29s timeout
3. `AttachmentsBucket` — S3 bucket with CORS rules for direct frontend uploads

Set `PUBLIC_FRONTEND_URL` to the deployed frontend origin so browser requests are allowed.

## Proxy (CNB workspace / Gemini Live)

Gemini Live checks the caller's region. If the workspace exit region is unsupported, the WebSocket handshake fails with `code=1007 User location is not supported for the API use.`

A Clash client listening on `127.0.0.1:7890` on the host is not reachable from inside the CNB container. Run a proxy client inside the container instead. The backend only uses a proxy when `HTTPS_PROXY`, `HTTP_PROXY`, or `ALL_PROXY` is explicitly set; there is no hard-coded default.

### Manual setup

1. Download Mihomo/Clash Meta (choose the asset for your architecture; `x86_64` example below):

```bash
mkdir -p /workspace/proxy
cd /workspace/proxy
curl -L --fail -o mihomo.gz \
  https://github.com/MetaCubeX/mihomo/releases/download/v1.19.34/mihomo-linux-amd64-compatible-v1.19.34.gz
gunzip -f mihomo.gz
chmod +x mihomo
./mihomo -v
```

2. Place your subscription export at `/workspace/proxy/config.yaml`. The config must include an HTTP/mixed port, for example:

```yaml
mixed-port: 7890
```

Never commit this file or share the subscription URL.

3. Validate and start the proxy:

```bash
cd /workspace/proxy
./mihomo -d . -t
nohup ./mihomo -d . > mihomo.log 2>&1 &
```

A successful start logs a line like `Mixed(http+socks) proxy listening at: [::]:7890`.

4. If the config has multiple nodes, select one supported by Gemini Live through the Clash RESTful API (assumes `external-controller: "127.0.0.1:9090"`):

```bash
GROUP=$(node -e "process.stdout.write(encodeURIComponent('YOUR_PROXY_GROUP'))")
curl -sS -X PUT "http://127.0.0.1:9090/proxies/$GROUP" \
  -H 'Content-Type: application/json' \
  -d '{"name":"YOUR_NODE_NAME"}'
```

5. Verify the exit region:

```bash
curl -x http://127.0.0.1:7890 https://ipinfo.io/json
```

The returned `country` must be supported by Gemini Live.

6. Enable the proxy for the backend and restart it:

```env
HTTPS_PROXY=http://127.0.0.1:7890
```

```bash
cd /workspace/Backend
npm run dev
```

Then refresh the frontend and re-enter the human call or real-time translation page.

### Persistence in CNB workspaces

- `Backend/.env` and the whole `proxy/` directory are ignored by Git.
- If any secret was committed before, rotate the affected keys/subscription and clean the Git history.
- A workspace restart does not restore background `mihomo` processes; restart the proxy after each rebuild.
- For automatic recovery, add `/root/.cnb` and `/root/.cnb/*` to the CNB custom roaming paths, then save sensitive files there:

```text
/root/.cnb/proxy-config.yaml    # Clash / Mihomo subscription config
/root/.cnb/backend.env          # KEY=VALUE snippet merged into Backend/.env
```

Run the one-click recovery script in a new environment:

```bash
bash /workspace/scripts/setup-proxy.sh
```

The script downloads Mihomo if missing, copies and validates the proxy config, creates/completes `Backend/.env`, enables `HTTPS_PROXY=http://127.0.0.1:7890`, starts Mihomo in the background, and prints the exit IP. Restart the backend in another terminal afterwards.

Do not stop the development environment with `kill 1`, otherwise roaming may not be saved. When multiple environments are open, the last one destroyed overwrites earlier roaming content.

## Repository Sync (CNB to GitHub)

The root `.cnb.yml` uses the official `tencentcom/git-sync` plugin to push the CNB `main` branch to GitHub on every push.

1. Create a CNB secret repository and add `github-sync.yml`:

```yaml
allow_slugs:
  - "YOUR_ORG/YOUR_REPO"
allow_events:
  - "push"
allow_branches:
  - "main"

GITHUB_REPO_URL: "https://github.com/YOUR_USER/YOUR_REPO.git"
GIT_USERNAME: "YOUR_GITHUB_USERNAME"
GIT_ACCESS_TOKEN: "GITHUB_PERSONAL_ACCESS_TOKEN"
```

2. In `.cnb.yml`, replace the secret repository slug in `imports` with your own.

3. Commit and push to CNB:

```bash
git add .cnb.yml
git commit -m "chore: add github sync pipeline"
git push origin main
```

Notes:

- Keep the GitHub token only in the CNB secret repository.
- `force: false` avoids rewriting GitHub history; change it only if CNB must be authoritative.
- The current pipeline syncs only `main` and does not push tags (`push_tags: false`).
