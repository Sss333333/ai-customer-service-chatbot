# AI 客户服务后端（`warranty-node`）

[English](./README.md) | [简体中文](./README.zh-CN.md)

AI 客户服务聊天机器人的 Node.js (ESM) 后端，提供聊天 API、语音 WebSocket 服务、pgvector RAG 检索、ERP 工具以及 AWS SAM 部署栈。产品功能请查看[根 README](../README.zh-CN.md)。

## 环境要求

- Node.js 20.x
- 安装了 `pgvector` 扩展的 PostgreSQL（RAG 必需）
- AWS 凭证与 S3 存储桶；本地开发可设置 `LOCAL_DEV_MOCK_S3=true`
- 部署需要 [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)

## 本地运行

```bash
cd Backend
cp .env.example .env
# 在 .env 中填写必要配置（见下方「配置」）
npm install
npm run dev
```

服务默认监听 `http://localhost:8080`。

| 接口 | 说明 |
| --- | --- |
| `POST /chat` | 流式对话与工具调用 API |
| `POST /upload-url` | 生成附件直传用的 S3 预签名 PUT URL |
| `GET /health` | 服务与模型健康检查 |
| `WS /ws/asr` | DashScope 实时语音识别 |
| `WS /ws/tts` | Edge TTS 流式语音播放 |
| `WS /ws/human` | 跨语言实时人工客服通话，Gemini Live 在通话中即时翻译 |

可用脚本：

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 使用 `node --watch` 启动 |
| `npm start` | 不使用 watch 模式启动一次 |
| `npm test` | 运行后端工具测试 |
| `npm run db:seed` | 导入 RAG 知识库文档 |
| `npm run rag:test` | 验证 RAG 检索 |

## 配置

以 `Backend/.env.example` 为模板，主要配置分组如下：

- **服务**：`PORT`、`PUBLIC_FRONTEND_URL`、`CHAT_DEADLINE_MS`
- **大模型**：`OPENROUTER_API_KEY`、`OPENROUTER_MODEL`、`OPENROUTER_EMBEDDING_MODEL`
- **RAG**：`DATABASE_URL`
- **存储**：`S3_BUCKET_NAME`、`AWS_REGION`、`LOCAL_DEV_MOCK_S3`
- **语音**：`DASHSCOPE_API_KEY`、`DASHSCOPE_ASR_MODEL`、`DEFAULT_TTS_VOICE`、`GEMINI_API_KEY`
- **ERP**：认证凭证、工单表单 ID、库存脚本 ID 及默认值
- **代理**：`HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`（可选，见[代理配置](#代理cnb-工作区--gemini-live)）

`CHAT_DEADLINE_MS` 默认是 `25000`。请保持它小于 Lambda 超时（`template.yaml` 中为 `29s`）和 API Gateway 上限（`30s`）。

ERP 集成代码（`Backend/src/tools/` 与 `Backend/src/services/`）中的自定义字段标识是占位符，例如 `custitem_custom_*`、`custevent_case_evidence_link`。正式使用 ERP 工具前请按你的 ERP 账户结构修改。

## RAG 知识库

将 `DATABASE_URL` 指向已安装 `pgvector` 的 PostgreSQL，设置 `OPENROUTER_API_KEY`，然后导入文档：

```bash
cd Backend
npm run db:seed
```

可用 `npm run rag:test` 验证检索效果。

## 部署到 AWS

SAM 栈名为 `warranty-node`，区域由 `samconfig.toml` 指定为 `ap-southeast-2`。

```bash
cd Backend

# 首次部署
sam build
sam deploy --guided

# 后续部署
sam deploy
```

栈会创建：

1. `HttpApi` — 开启 CORS 的 API Gateway v2
2. `WarrantyFunction` — Node.js 20.x / arm64 Lambda，绑定 S3 权限，超时 29 秒
3. `AttachmentsBucket` — 配置 CORS、允许前端直传的 S3 存储桶

请将 `PUBLIC_FRONTEND_URL` 设置为部署后的前端域名，以允许浏览器跨域请求。

## 代理（CNB 工作区 / Gemini Live）

Gemini Live 会按出口 IP 判断地区。如果工作区出口地区不受支持，WebSocket 握手会返回 `code=1007 User location is not supported for the API use.`

宿主机上的 Clash `127.0.0.1:7890` 在 CNB 容器内不可达，需要在容器内运行代理客户端。后端只有在显式设置 `HTTPS_PROXY`、`HTTP_PROXY` 或 `ALL_PROXY` 时才走代理，没有硬编码的默认代理。

### 手动配置

1. 下载 Mihomo/Clash Meta（按架构选择，下面以 `x86_64` 为例）：

```bash
mkdir -p /workspace/proxy
cd /workspace/proxy
curl -L --fail -o mihomo.gz \
  https://github.com/MetaCubeX/mihomo/releases/download/v1.19.34/mihomo-linux-amd64-compatible-v1.19.34.gz
gunzip -f mihomo.gz
chmod +x mihomo
./mihomo -v
```

2. 把订阅配置导出到 `/workspace/proxy/config.yaml`，并确保包含 HTTP/mixed 端口，例如：

```yaml
mixed-port: 7890
```

不要提交该文件，也不要公开订阅链接。

3. 校验并启动代理：

```bash
cd /workspace/proxy
./mihomo -d . -t
nohup ./mihomo -d . > mihomo.log 2>&1 &
```

启动成功会看到类似 `Mixed(http+socks) proxy listening at: [::]:7890` 的日志。

4. 如果配置里有多个节点，可通过 Clash RESTful API 切换（假设 `external-controller: "127.0.0.1:9090"`）：

```bash
GROUP=$(node -e "process.stdout.write(encodeURIComponent('YOUR_PROXY_GROUP'))")
curl -sS -X PUT "http://127.0.0.1:9090/proxies/$GROUP" \
  -H 'Content-Type: application/json' \
  -d '{"name":"YOUR_NODE_NAME"}'
```

5. 验证出口地区：

```bash
curl -x http://127.0.0.1:7890 https://ipinfo.io/json
```

返回的 `country` 必须是 Gemini Live 支持的地区。

6. 在后端启用代理并重启：

```env
HTTPS_PROXY=http://127.0.0.1:7890
```

```bash
cd /workspace/Backend
npm run dev
```

然后刷新前端页面，重新进入人工通话或实时翻译。

### CNB 工作区中的持久化

- `Backend/.env` 和整个 `proxy/` 目录都已被 Git 忽略。
- 如果曾经误提交过密钥，请立即轮换相关 API key / 订阅链接并清理 Git 历史。
- 工作区重启后后台 `mihomo` 不会自动恢复，重建环境后需要重新启动代理。
- 如需自动恢复，在 CNB「个人设置 → 云原生开发」的自定义漫游路径中加入 `/root/.cnb` 和 `/root/.cnb/*`，然后保存敏感文件：

```text
/root/.cnb/proxy-config.yaml    # Clash / Mihomo 订阅配置
/root/.cnb/backend.env          # 需要合并进 Backend/.env 的 KEY=VALUE 片段
```

新环境中执行一键恢复脚本：

```bash
bash /workspace/scripts/setup-proxy.sh
```

脚本会按需下载 Mihomo、复制并校验代理配置、创建/补齐 `Backend/.env`、启用 `HTTPS_PROXY=http://127.0.0.1:7890`、后台启动 Mihomo 并打印出口 IP。随后在另一个终端重启后端。

不要用 `kill 1` 关闭开发环境，否则漫游内容可能不会保存；同时打开多个环境时，后销毁的环境会覆盖先销毁的环境漫游内容。

## 仓库同步（CNB → GitHub）

根目录 `.cnb.yml` 使用官方 `tencentcom/git-sync` 插件，在每次 push 时把 CNB 的 `main` 分支推送到 GitHub。

1. 创建 CNB 密钥仓库，并新建 `github-sync.yml`：

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

2. 在 `.cnb.yml` 的 `imports` 中把密钥仓库 slug 替换成你自己的。
3. 提交并推送到 CNB：

```bash
git add .cnb.yml
git commit -m "chore: add github sync pipeline"
git push origin main
```

注意：

- GitHub token 只能放在 CNB 密钥仓库中。
- `force: false` 避免覆盖 GitHub 历史；只有确认以 CNB 为准时才改为 `true`。
- 当前只同步 `main` 分支，不推送 tags（`push_tags: false`）。
