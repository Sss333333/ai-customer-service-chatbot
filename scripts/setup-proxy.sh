#!/usr/bin/env bash
set -euo pipefail

ROOT="/workspace"
PROXY_DIR="$ROOT/proxy"
ENV_FILE="$ROOT/Backend/.env"
ENV_EXAMPLE="$ROOT/Backend/.env.example"
ROAM_DIR="${CNB_PROXY_ROAM_DIR:-/root/.cnb}"
CONFIG_SRC="$ROAM_DIR/proxy-config.yaml"
ENV_SRC="$ROAM_DIR/backend.env"
MIHOMO_VERSION="v1.19.34"

log() { printf '\n==> %s\n' "$1"; }

log "准备代理目录"
mkdir -p "$PROXY_DIR"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) ASSET="mihomo-linux-amd64-compatible-${MIHOMO_VERSION}.gz" ;;
  aarch64|arm64) ASSET="mihomo-linux-arm64-${MIHOMO_VERSION}.gz" ;;
  *) echo "不支持的架构: $ARCH" >&2; exit 1 ;;
esac

if [ ! -x "$PROXY_DIR/mihomo" ]; then
  log "下载 Mihomo 内核 ($ARCH)"
  curl -L --fail --retry 2 -o "$PROXY_DIR/mihomo.gz" \
    "https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/${ASSET}"
  gunzip -f "$PROXY_DIR/mihomo.gz"
  chmod +x "$PROXY_DIR/mihomo"
else
  log "Mihomo 内核已存在，跳过下载"
fi

if [ ! -f "$PROXY_DIR/config.yaml" ]; then
  if [ ! -f "$CONFIG_SRC" ]; then
    echo "缺少代理配置：$CONFIG_SRC" >&2
    echo "请把订阅配置保存到 $CONFIG_SRC，或手动放到 $PROXY_DIR/config.yaml" >&2
    exit 1
  fi
  log "从漫游目录复制代理配置"
  cp "$CONFIG_SRC" "$PROXY_DIR/config.yaml"
else
  log "代理配置已存在，跳过复制"
fi

log "校验代理配置"
"$PROXY_DIR/mihomo" -d "$PROXY_DIR" -t

if [ ! -f "$ENV_FILE" ]; then
  log "创建 Backend/.env"
  if [ -f "$ENV_EXAMPLE" ]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
  else
    touch "$ENV_FILE"
  fi
fi

if [ -f "$ENV_SRC" ]; then
  log "合并漫游目录中的环境变量片段"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|\#*) continue ;;
    esac
    key="${line%%=*}"
    if ! grep -qE "^${key}=" "$ENV_FILE"; then
      printf '%s\n' "$line" >> "$ENV_FILE"
    fi
  done < "$ENV_SRC"
fi

log "确保 HTTPS_PROXY 已启用"
if grep -qE '^#?[[:space:]]*HTTPS_PROXY=' "$ENV_FILE"; then
  sed -i -E 's|^#?[[:space:]]*HTTPS_PROXY=.*|HTTPS_PROXY=http://127.0.0.1:7890|' "$ENV_FILE"
else
  printf '\nHTTPS_PROXY=http://127.0.0.1:7890\n' >> "$ENV_FILE"
fi

if ! pgrep -f 'mihomo -d' >/dev/null 2>&1; then
  log "后台启动 Mihomo"
  cd "$PROXY_DIR"
  nohup ./mihomo -d . > mihomo.log 2>&1 &
else
  log "Mihomo 已在运行，跳过启动"
fi

sleep 2
log "当前代理出口 IP"
curl -sS -x http://127.0.0.1:7890 https://ipinfo.io/json || true
printf '\n'

log "完成"
echo "请在另一个终端重启后端：cd $ROOT/Backend && npm run dev"
