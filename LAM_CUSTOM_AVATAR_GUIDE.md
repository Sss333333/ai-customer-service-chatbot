# LAM 自定义 3D 角色：生成与导出（Agent 执行手册）

> 适用对象：能执行 shell 命令的编码智能体（Claude Code、Codex、Antigravity 等）。
> 依据：`aigc3d/LAM` 的 `README`、`tools/AVATAR_EXPORT_GUIDE.md`，以及 `AIChatBot-LAM` 实测验证结果（2026-11-24）。

---

## 1. 目标与产出

- **输入**：一张角色正脸图。
- **产出**：可导入 `OpenAvatarChat` / `AIChatBot-LAM` 的 LAM 3D 数字人 `.zip` 资产包。
- **运行位置**：带 NVIDIA 显卡的 Linux 机器（云 GPU）。LAM 官方生成与导出仅提供 CUDA 安装脚本，**不要**在无 NVIDIA 显卡的机器上尝试生成。

---

## 2. 执行规则（必须遵守）

1. 每一步结束后执行“验证”命令，不通过就停止，不要进入下一步。
2. 不要猜测文档没有写明的内容（文件名、端口、按钮名称）。需要时用 `ls`、`cat`、读日志来确认。
3. 失败时停止并汇报：失败的步骤、完整报错、已尝试的处理。同一步骤最多自动重试 2 次。
4. 只在 `LAM` 仓库目录和 `$HOME/software` 内写文件。`rm` 只用于本文明确写出的清理，执行前先 `pwd` 确认当前目录。
5. 不要输出或保存任何密钥、令牌。
6. 标记 **【需人工】** 的步骤交给用户，等用户回复后再继续。

---

## 3. 需要用户提供

- **角色图片路径**：建议正脸、光线均匀、五官清晰、闭口自然微笑、头顶与肩部四周留白充足、无遮挡（经验要求，非官方硬性规定）。
- **一台已开好的云 GPU 实例访问权限**：Linux + Python 3.10 + CUDA 基础镜像；建议显存 ≥ 24GB、磁盘剩余 ≥ 50GB（经验值）。

---

## 4. 执行步骤

### Step 1：环境检查

```bash
nvidia-smi
python --version
df -h .
git --version
wget --version | head -1
```

**通过标准**：
- `nvidia-smi` 能列出显卡，记录右上角的 `CUDA Version`（供 Step 2 选择脚本）。
- Python 为 `3.10.x`（Step 4 官方提供的 FBX SDK wheel 是 `cp310` 版本）。若不是 3.10，先停止并询问用户，不要自行换版本。
- 能正常访问 `github.com` 与 `modelscope.cn`（或 `hf-mirror.com`）。

---

### Step 2：克隆仓库并安装依赖

```bash
git clone https://github.com/aigc3d/LAM.git
cd LAM
```

按 Step 1 记录的 `CUDA Version` 选择对应脚本：
- `12.1` 及以上：运行 `install_cu121.sh`
- `11.8` 到 `12.0`：运行 `install_cu118.sh`
- 低于 `11.8`：停止并汇报

```bash
sh ./scripts/install/install_cu121.sh
# 或
# sh ./scripts/install/install_cu118.sh
```

**验证**：
```bash
python -c 'import torch; print(torch.__version__, torch.cuda.is_available())'
```
输出的第二项必须是 `True`。

---

### Step 3：下载资源包与权重

先确认当前目录是 `LAM` 仓库根目录（`pwd`）。

**方式 A（优先使用 ModelScope）**：
```bash
pwd
pip3 install modelscope
modelscope download --model 'Damo_XR_Lab/LAM-assets' --local_dir './tmp/'
tar -xf ./tmp/LAM_assets.tar && rm ./tmp/LAM_assets.tar
tar -xf ./tmp/thirdparty_models.tar && rm -r ./tmp/
modelscope download --model 'Damo_XR_Lab/LAM-20K' --local_dir './model_zoo/lam_models/releases/lam/lam-20k/step_045500/'
```

**方式 B（ModelScope 失败时改用 HuggingFace 镜像）**：
先确认 `./tmp` 里没有上一次失败遗留的残缺文件，有的话清理后再下（注意锁定 `huggingface_hub<1.0`，因为 1.x 已移除 `huggingface-cli`）：
```bash
pip install -U "huggingface_hub<1.0"
export HF_ENDPOINT=https://hf-mirror.com
huggingface-cli download 3DAIGC/LAM-assets --local_dir ./tmp
tar -xf ./tmp/LAM_assets.tar && rm ./tmp/LAM_assets.tar
tar -xf ./tmp/thirdparty_models.tar && rm -r ./tmp/
huggingface-cli download 3DAIGC/LAM-20K --local_dir ./model_zoo/lam_models/releases/lam/lam-20k/step_045500/
```

> 说明：官方权重表里目前公开可用的主权重为 `LAM-20K`（VFHQ + NeRSemble），不要去找表中标为 `TBD` 的权重。

**验证**：
```bash
ls -la model_zoo/lam_models/releases/lam/lam-20k/step_045500/
ls
```
权重目录必须非空。把解压出的新目录名一并汇报给用户。

---

### Step 4：安装导出工具

以下下载地址在阿里云 OSS 和 Blender 官网，不依赖 HF 与 ModelScope：

```bash
wget https://virutalbuy-public.oss-cn-hangzhou.aliyuncs.com/share/aigc3d/data/LAM/fbx-2020.3.4-cp310-cp310-manylinux1_x86_64.whl
pip install fbx-2020.3.4-cp310-cp310-manylinux1_x86_64.whl
pip install patool   # 注意：Python 3.10 已内置标准库 pathlib，切勿 pip install pathlib

wget https://download.blender.org/release/Blender4.0/blender-4.0.2-linux-x64.tar.xz
mkdir -p "$HOME/software"
tar -xvf blender-4.0.2-linux-x64.tar.xz -C "$HOME/software/"

wget https://virutalbuy-public.oss-cn-hangzhou.aliyuncs.com/share/aigc3d/data/LAM/sample_oac.tar
mkdir -p assets
tar -xf sample_oac.tar -C assets/
```

**验证**：
```bash
python -c 'import fbx; print("fbx ok")'
"$HOME/software/blender-4.0.2-linux-x64/blender" --version
ls assets/
```
三项都要成功。Blender 若报缺少系统库（如 `libXi`、`libXrender`、`libGL` 等），把完整报错汇报给用户，确认后再安装系统包，不要自行猜测。

---

### Step 5：启动生成界面

```bash
nohup python app_lam.py --blender_path "$HOME/software/blender-4.0.2-linux-x64/blender" > lam_app.log 2>&1 &
sleep 60
tail -n 30 lam_app.log
```

- 模型加载可能需要几分钟，每 30 秒查看一次日志，最长等 5 分钟。
- 从日志中找出实际监听的地址和端口，不要假设端口号。
- 日志出现 `Traceback` 就停止并汇报。

**验证**（把 `PORT` 换成日志里的端口，使用 `GET` 避免 `HEAD` 返回 405）：
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:PORT
```
应输出 `200`。

**【需人工】** 云 GPU 的端口通常不能直接从公网访问。请用户在自己电脑上执行 SSH 隧道，或使用云平台提供的端口映射：
```bash
ssh -L PORT:127.0.0.1:PORT -p SSH端口 root@实例地址
```
然后用户在本机浏览器打开 `http://127.0.0.1:PORT`。

---

### Step 6：生成与导出角色

**路径 A（官方导出路径，推荐）**：在 Gradio 界面操作。
- 如果你有浏览器工具：打开页面，先检查页面上实际的控件，再上传图片、选择示例驱动视频、触发生成并导出 OpenAvatarChat 所需 `.zip`（按钮名称以页面实际内容为准）。
- 如果没有浏览器工具：**【需人工】** 请用户在界面里完成上传图片、选择驱动视频、生成和导出，完成后告知你。

**路径 B（命令行，仅用于验证重建，不能替代路径 A）**：
```bash
sh ./scripts/inference.sh ${CONFIG} ${MODEL_NAME} ${IMAGE_PATH_OR_FOLDER} ${MOTION_SEQ}
```
四个参数的取值先执行 `cat scripts/inference.sh` 和 `ls configs` 确认。官方 README 未说明该脚本会导出 OpenAvatarChat `.zip`，因此仅用于验证模型推理是否正常。

---

### Step 7：取回产物

```bash
find . /tmp -path './.git' -prune -o -path './model_zoo' -prune -o -type f -name '*.zip' -mmin -120 -print 2>/dev/null
ls -lh 找到的文件路径
unzip -l 找到的文件路径 | head -40
```

- 优先结合 `lam_app.log` 中的导出日志核对最终生成的 `.zip` 路径，避免误拿缓存或无关压缩包。
- 把 `.zip` 的完整路径、大小和内容清单汇报给用户。
- 让用户通过平台的文件下载功能，或在本机执行 `scp` 把文件取回。

---

### Step 8：在 `AIChatBot-LAM` 项目中加载（已实测验证）

1. 将取回的 `.zip`（例如 `nova.zip`）复制到本地项目目录：
   `F:/Workspace/SDF/AIChatBot-LAM/AvatarService/src/handlers/client/ws_lam_client/lam_samples/nova.zip`
2. 启动轻量 LAM 服务并指定该形象（纯 WebSocket，无需 WebRTC/TURN；本机纯 CPU 实测待机 CPU `0%`、内存 `~1.3 GB`）：
   ```powershell
   cd F:\Workspace\SDF\AIChatBot-LAM\AvatarService
   $env:PATH = "$PWD\.venv\Scripts;$env:PATH"
   python src\lam_server.py --port 8282 --asset nova.zip
   ```
3. 启动 `AIChatBot-LAM/Backend`（端口 `8080`）与 `AIChatBot-LAM/Frontend`（端口 `5173`），访问 `http://localhost:5173` 即可看到新 3D 角色并联动语音口型。
4. 公网部署注意事项：
   - 浏览器调用麦克风（实时语音通话）强制要求 **HTTPS**（或 `localhost`）；
   - 建议将 `.zip` 形象包放 CDN，减少源站带宽占用。

---

## 5. 故障排查

| 现象 | 可能原因 | 处理 |
| :--- | :--- | :--- |
| `torch.cuda.is_available()` 为 `False` | 驱动或 CUDA 版本与安装脚本不匹配 | 对照 `nvidia-smi` 重选 `cu121` 或 `cu118` |
| 下载权重失败 / `huggingface-cli` 不存在 | 网络不可达或安装了 `huggingface_hub>=1.0` | 换 ModelScope 或锁定 `"huggingface_hub<1.0"`；清理残缺 `./tmp` 后重试 |
| 启动时找不到权重或资源 | 目录路径不对，或 `tar` 未解压完整 | 核对 Step 3 的目录与 `ls` 输出 |
| `import fbx` 失败 | Python 不是 3.10，或 wheel 未装成功 | 停止并汇报，不要自行换版本 |
| `pathlib` 相关 `AttributeError` | 误装了 PyPI 第三方 `pathlib` 覆盖了标准库 | 执行 `pip uninstall -y pathlib` |
| 导出报 Blender 错误 | `--blender_path` 未展开 `~` 或缺系统库 | 改用 `$HOME` 绝对路径，缺库时汇报完整报错 |
| 页面打不开 | 未做端口转发 | 按 Step 5 建立 SSH 隧道或平台端口映射 |
| 角色效果差 / 裁头 | 输入图不合适或头顶无留白 | 换正脸、光线均匀、头顶留白充足的清晰图 |

---

## 6. 收尾

- 确认用户已成功取回 `.zip` 后，提醒用户**释放云 GPU 实例以停止计费**。
- 按以下格式向用户汇报：
  1. 各步骤是否通过；
  2. 产物 `.zip` 路径、大小与文件清单；
  3. 未完成或需要人工确认的事项。

---

## 7. 本文未确认的事项

- 生成侧显存、磁盘的最低硬性要求，官方未写（建议 24GB 显存 + 50GB 可用磁盘为经验值）。
- Gradio 界面的具体控件名称与默认端口，以实际页面和 `lam_app.log` 为准。
- `app_lam.py` 导出 `.zip` 的具体输出路径，以 Step 7 实际查找结果和日志为准。
- `MeshLAM` 等新工作暂不纳入本流程。
