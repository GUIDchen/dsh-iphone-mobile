#!/usr/bin/env bash
# 弱网压测：注入延迟与丢包，便于观察断线重连、断点续传与审批幂等。
# 用法：LOSS=3 DELAY=200 ./scripts/stress-test.sh
# 异常退出也会自动清理注入规则（trap）。
set -euo pipefail

LOSS=$LOSS
[ -n "$LOSS" ] || LOSS=3
DELAY=$DELAY
[ -n "$DELAY" ] || DELAY=200
DURATION=$DURATION
[ -n "$DURATION" ] || DURATION=60
IFACE=$IFACE
[ -n "$IFACE" ] || IFACE=en0
ANCHOR=dsh-stress

cleanup_macos() {
  sudo pfctl -a "$ANCHOR" -F rules 2>/dev/null || true
  sudo dnctl -q flush 2>/dev/null || true
  echo "已清理注入规则（若本次由脚本启用 pf，可执行 sudo pfctl -d 关闭）"
}
cleanup_linux() {
  sudo tc qdisc del dev "$IFACE" root 2>/dev/null || true
  echo "已清理 netem 规则"
}

if [ "$(uname -s)" = "Darwin" ]; then
  trap cleanup_macos EXIT
  # ponytail: 只影响新建 TCP 连接方向，不影响 UDP；压测 UDP 回退场景请另配规则
  sudo dnctl pipe 1 config delay "$DELAY"ms plr 0.0$LOSS
  echo "dummynet out proto tcp from any to any pipe 1" | sudo pfctl -a "$ANCHOR" -f -
  sudo pfctl -E >/dev/null 2>&1 || true
  echo "已注入：delay $DELAY ms，丢包 0.0$LOSS（$(uname -s)）"
else
  trap cleanup_linux EXIT
  sudo tc qdisc add dev "$IFACE" root netem delay "$DELAY"ms loss "$LOSS"%
  echo "已注入：delay $DELAY ms，丢包 $LOSS%（接口 $IFACE）"
fi

echo "持续 $DURATION 秒。请在手机上做：锁屏 60 秒、切后台、开飞行模式、点一次审批。"
sleep "$DURATION"
