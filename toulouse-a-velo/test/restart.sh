#!/bin/sh
# 開いたままの撮影のセッションを止めて、ビルドし直す。続けて別のシェルで（背景で）立ち上げる:
#   SESSION=1 AREA=centre NODE_USE_ENV_PROXY=1 node test/real-mode.mjs '[]' > test/output/session.log 2>&1
#   （準備ができると test/output/cmd.out に ready と書く。sh test/cmd.sh '[…]' で撮影の一覧を渡す）
cd "$(dirname "$0")/.."
out=test/output
pkill -9 -f "node test/real-mode.mjs" 2>/dev/null; sleep 0.5; pkill -9 -f "node test/real-mode.mjs" 2>/dev/null
rm -f $out/cmd.json $out/cmd.out
npm run build 2>&1 | grep -E "error|built in"
