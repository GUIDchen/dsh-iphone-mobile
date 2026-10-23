#!/usr/bin/env bash
# 把 dsh-mobile-gateway 通过 Tailscale 暴露成 tailnet 内可达的 HTTPS 入口。
# 幂等：可重复执行。不会修改 dsh web 的监听地址。
#
# 为什么指向网关（3081）而不是 dsh web（3080）：
# dsh 的 /api 有浏览器信任围栏，Host 必须是 loopback 或 --trusted-host 声明的权威。
# tailscale serve 转发时会带上 ts.net 主机名，直连 3080 会被围栏 403；
# 网关会把 Host 重写回 loopback 并自带令牌鉴权，因此必须走网关。
set -euo pipefail

PORT=$GATEWAY_PORT
[ -n "$PORT" ] || PORT=3081
TARGET="http://127.0.0.1:$PORT"

TS=$(command -v tailscale || true)
[ -n "$TS" ] || TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
[ -x "$TS" ] || { echo "未找到 Tailscale CLI。macOS: brew install --cask tailscale；Linux: 见官方安装文档"; exit 1; }

if ! "$TS" status >/dev/null 2>&1; then
  echo "Tailscale 未登录或未启动，请先打开 App 完成登录"
  exit 1
fi

if ! curl -sS -o /dev/null --max-time 3 "$TARGET"; then
  echo "警告：$TARGET 无响应，请先启动网关（npm start）"
fi

HOST=$("$TS" status --json | python3 -c "import sys,json;print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))")

"$TS" serve --bg --https=443 "$TARGET"

echo
echo "入口：https://$HOST"
echo "手机：安装 Tailscale 并登录同一账号后，用蜂窝网络打开上面的地址验证。"
echo "令牌：cat ~/.dsh-mobile/token（首次访问用 /login?token=<令牌> 换取 Cookie）"
