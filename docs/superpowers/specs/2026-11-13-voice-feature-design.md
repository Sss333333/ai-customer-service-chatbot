# AIChatBot 语音功能移植设计规范 (Voice Feature Design Spec)

## 1. 背景与目标
将高质量 Agent 语音能力（语音输入 ASR + 语音播报 TTS）完整集成到本 AI Customer Service 项目中。

- **ASR (语音输入)**：用户在聊天界面长按麦克风说话，客户端进行 16kHz WAV 重采样后直传后端，由阿里百炼 DashScope Paraformer 实时语音模型完成转写并自动发送消息。
- **TTS (语音播报)**：基于微软 Edge-TTS 原生 WebSocket 直连实现，清洗 Markdown 与 Emoji 后流式回传 MP3 音频，支持单条消息朗读与新消息“自动播报”开关。

---

## 2. 后端架构设计 (`NewBackend`)

### 2.1 模块划分 (`NewBackend/src/audio/`)
- `sanitizer.js`：清洗大模型输出文本，去除 Markdown 代码块、排版符号、链接与 Emoji 表情，输出纯发音自然口语。
- `edgeTts.js`：微软 Edge-TTS 原生客户端。
  - 动态计算 `Sec-MS-GEC` 鉴权签名；
  - 构造 SSML 语音合成协议；
  - 监听 WebSocket 二进制流并解析音频帧（去除 2 字节头），流式推送。
- `paraformerWs.js`：阿里百炼 DashScope Paraformer 语音识别客户端。
  - 通过 WebSocket 直连 `wss://dashscope.aliyuncs.com/api-ws/v1/inference`；
  - 发送 `run-task`，分块推流 100ms 帧长音频数据；
  - 接收转写结果文本。

### 2.2 API 路由与控制器 (`NewBackend/src/api/router.js` & `src/index.js`)
- `GET /api/audio/speak` & `POST /api/audio/speak`：
  - 参数：`text`（文本），`voice`（可选，默认 `zh-CN-XiaoxiaoNeural`）；
  - 响应：ETag 强缓存支持 304；未命中时以 `audio/mpeg` 分块流式边下边播。
- `POST /api/audio/transcribe`：
  - 接收 multipart/form-data 录音文件；
  - 调用 `paraformerWs` 完成转写，返回 `{ success: true, text: "..." }`。

### 2.3 环境配置 (`NewBackend/.env`)
- `DASHSCOPE_API_KEY`: 阿里百炼 API 密钥
- `DASHSCOPE_ASR_MODEL`: 默认 `paraformer-realtime-v2`
- `DEFAULT_TTS_VOICE`: 默认 `zh-CN-XiaoxiaoNeural`

---

## 3. 前端架构设计 (`frontend`)

### 3.1 工具与 Hook
- `frontend/src/utils/audioWav.js`：Web Audio API 客户端离线重采样（任何格式转为 16kHz 16-bit 单声道 WAV）。
- `frontend/src/hooks/useAudioRecorder.js`：控制麦克风录制，降噪与回声消除，短按与超时保护。
- `frontend/src/hooks/useAudioPlayer.js`：控制 HTMLAudioElement 播放，支持 ETag 缓存、超时熔断与 `autoSpeak` 自动朗读管理。

### 3.2 交互组件
- `frontend/src/components/VoiceInputButton.jsx`：
  - 底部输入栏按住说话、松开发送；
  - 录音动效浮层（显示录音时长与取消指引）；
  - 转写完成后自动触发 `sendMessage({ text })`。
- `frontend/src/components/AudioPlayButton.jsx`：
  - 挂载在 Assistant 消息气泡上，展示“播放 / 正在缓冲 / 停止”状态。
- `App.jsx` 改造：
  - 顶部导航栏增加 Auto-Speak（自动朗读）开关按钮；
  - Assistant 气泡增加 `AudioPlayButton`；
  - 底部输入框挂载 `VoiceInputButton`。

---

## 4. 依赖项变更
- `NewBackend`：安装 `ws` 依赖用于后端直连 Edge-TTS 和 DashScope WebSocket。
- `frontend`：无需额外外部依赖，基于原生 Web Audio API 与 React 19。
