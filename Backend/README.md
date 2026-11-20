# AI Customer Service Backend (`warranty-node`)

AI 客户服务 Agent 云端后端架构。支持 **OpenRouter LLM + Vercel AI SDK**、**pgvector RAG 知识库**、**NetSuite ERP Tool Use**、**实时语音 ASR/TTS** 与 **AWS SAM** 部署。

---

## 架构概览

- **LLM 调度引擎**：AWS Bedrock `ConverseCommand` / `InvokeModelCommand`，驱动 `anthropic.claude-3-5-sonnet-20240620-v1:0`
- **Tool Use (Function Calling) 闭环**：
  - `get_product_info`：直连 NetSuite ERP (SuiteQL) 实时查询产品规格、状态与各州仓库库存
  - `start_warranty_claim`：质保报障与工单生成
  - `check_order_status`：经销商/账户订单跟踪查询
- **附件上传**：`POST /upload-url` 生成安全直传至 S3 存储桶的预签名 PUT URL（本地模式支持 Mock 兜底）
- **双模支持**：
  - **本地开发模式**：原生 Node.js HTTP 服务秒级启动 (`npm run dev`)
  - **云端生产模式**：AWS SAM 模板定义 `warranty-node` 栈一键部署至 AWS 悉尼区 (`ap-southeast-2`)

---

## 本地快速启动

```bash
cd Backend
npm install
npm run dev
```

启动后默认监听端口 `http://localhost:8080`：
- `POST /chat` — 对话及工具调用接口
- `POST /upload-url` — 预签名附件上传接口
- `GET /health` — 服务与模型健康检查

---

## 部署到 AWS (1:1 原版对齐)

确保本地已安装 [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) 且已配置好 AWS 凭证：

```bash
cd Backend

# 1. 编译构建
sam build

# 2. 引导式部署 (首次)
sam deploy --guided

# 后续快速部署
sam deploy
```

部署完成后，SAM 会自动创建：
1. `HttpApi` (API Gateway v2)
2. `WarrantyFunction` (Node.js 20.x Lambda 函数，绑定 Bedrock 与 S3 权限)
3. `AttachmentsBucket` (S3 存储桶，配置 CORS 允许前端直传照片和视频)
