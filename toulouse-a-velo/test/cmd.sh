#!/bin/sh
# 開いたままの撮影のセッション（SESSION=1 node test/real-mode.mjs）に撮影の一覧を渡して、終わるまで待つ
#   sh test/cmd.sh '[{"name":"a","lm":"pont-neuf"}]'
out="$(dirname "$0")/output"
rm -f "$out/cmd.out"
printf '%s' "$1" > "$out/cmd.tmp" && mv "$out/cmd.tmp" "$out/cmd.json"
until [ -f "$out/cmd.out" ]; do sleep 0.5; done
cat "$out/cmd.out"
