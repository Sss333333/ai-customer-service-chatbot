# AI 客户服务前端

[English](./README.md) | [简体中文](./README.zh-CN.md)

AI 客户服务聊天机器人的 React 19 + Vite + Tailwind CSS 单页应用。产品功能请查看[根 README](../README.zh-CN.md)。

## 环境要求

- Node.js 20.x
- 已启动的后端服务（见[后端 README](../Backend/README.zh-CN.md)）

## 本地运行

```bash
cd Frontend
npm install
npm run dev
```

开发服务器地址为 `http://localhost:5173`。

本地开发时请保持 `VITE_API_BASE` 为空，让请求走下面描述的 Vite 开发代理。

## 开发代理

`vite.config.js` 会把后端请求代理到 `http://localhost:8080`：

| 路径 | 目标 | WebSocket |
| --- | --- | --- |
| `/chat` | `http://localhost:8080` | 否 |
| `/upload-url` | `http://localhost:8080` | 否 |
| `/api` | `http://localhost:8080` | 是 |
| `/ws` | `http://localhost:8080` | 是 |

这覆盖了流式对话、附件上传、音频转写、ASR、TTS 和人工通话 WebSocket。`allowedHosts` 当前包含 CNB 预览域名 `5wqv5khjzb-5173.cnb.run`；如果使用其他预览域名，请自行添加。

如果前端与后端部署在不同域名下，请在构建时把 `VITE_API_BASE` 设置为后端域名。WebSocket Hook 会基于该值推导地址，例如 `VITE_API_BASE=https://api.example.com` 会生成 `wss://api.example.com/ws/asr`。

## 构建

```bash
cd Frontend
npm run build
npm run preview
```

`npm run build` 会把静态资源输出到 `dist/`。`npm run preview` 可在本地预览该目录。

## 部署

前端是静态 SPA，可以部署到任意静态文件服务或 CDN。

1. 执行 `npm run build`。
2. 发布 `dist/` 目录中的内容。
3. 配置 SPA 回退，使 `/agent` 等未知路由都返回 `index.html`。
4. 如果后端在另一个域名下，构建前设置 `VITE_API_BASE`，并确认后端 `PUBLIC_FRONTEND_URL` 与 CORS 配置允许前端域名。
5. 确保 CDN 或网关转发 `/ws/*` 和 `/api/*` 路径的 WebSocket Upgrade 请求。

不要把 API key 放在前端环境变量中；所有密钥应放在后端或 CNB 密钥仓库里。
