#!/usr/bin/env bash
# 域名到位后执行：接 Cloudflare Tunnel 并把 dsh-mobile-gateway 发布为公网 HTTPS 入口。
# 为什么指向网关（3081）而不是 dsh web（3080）：cloudflared 默认保留原始 Host，
# 公网域名进到 dsh web 会被 /api 信任围栏 403；网关会重写 Host 并自带令牌鉴权。
# 用法：DOMAIN=dsh.example.com ./scripts/setup-cloudflare-tunnel.sh
# 注意：执行前请确认域名已托管到 Cloudflare（NS 已切换）。
set -euo pipefail

[ -n "$DOMAIN" ] || { echo "用法：DOMAIN=dsh.example.com $0"; exit 1; }

TUNNEL=$TUNNEL
[ -n "$TUNNEL" ] || TUNNEL=dsh-mobile
PORT=$GATEWAY_PORT
[ -n "$PORT" ] || PORT=3081

command -v cloudflared >/dev/null || brew install cloudflared

if ! cloudflared tunnel list 2>/dev/null | grep -q "^$TUNNEL"; then
  cloudflared tunnel create "$TUNNEL"
fi

cloudflared tunnel route dns "$TUNNEL" "$DOMAIN"

UUID=$(cloudflared tunnel list | awk -v t="$TUNNEL" '$2 == t { print $1 }')
[ -n "$UUID" ] || { echo "无法取得隧道 UUID"; exit 1; }
mkdir -p "$HOME/.cloudflared"

cat > "$HOME/.cloudflared/config.yml" <<EOF
tunnel: $TUNNEL
credentials-file: $HOME/.cloudflared/$UUID.json

ingress:
  - hostname: $DOMAIN
    service: http://127.0.0.1:$PORT
  - service: http_status:404
EOF

sudo cloudflared service install

echo
echo "入口：https://$DOMAIN"
echo "下一步：Zero Trust → Access → 新建自托管应用覆盖该域名，并添加邮箱一次性验证码策略。"
echo "然后：手机打开 https://$DOMAIN/login?token=<令牌> 换 Cookie，并重新添加主屏幕、重订阅推送。"
