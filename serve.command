#!/bin/bash
# serve.command — 双击（或终端 ./serve.command）常驻启动 api-usage-board。
# 服务 = server/server.mjs（Node 内置模块，零依赖）：静态文件 + /api/* 真实数据，仅绑 127.0.0.1:8177。
# 已在跑则直接打开浏览器，不重复起。开着别关，改代码后浏览器刷新即可（缓存问题用 ⌘⇧R 强刷）。
cd "$(dirname "$0")"
PORT=8177

# node 探测：双击 .command 的 shell 不一定加载 nvm，按 命令→nvm.sh→版本目录 顺序找
NODE=$(command -v node 2>/dev/null || true)
if [ -z "$NODE" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
  NODE=$(command -v node 2>/dev/null || true)
fi
if [ -z "$NODE" ]; then
  NODE=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)
fi
if [ -z "$NODE" ]; then
  echo "未找到 node：请确认已安装 Node.js（或 nvm）。按任意键退出。"
  read -n 1
  exit 1
fi
echo "使用 node: $NODE ($($NODE -v))"

if ! lsof -i :$PORT >/dev/null 2>&1 && ! /usr/sbin/lsof -i :$PORT >/dev/null 2>&1; then
  (
    # 首开时 server 首轮扫描大日志要十几秒，等 /api/health 就绪再开浏览器（上限 60s）
    for i in $(seq 1 60); do
      /usr/bin/curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
      sleep 1
    done
    open "http://localhost:$PORT"
  ) &
  exec "$NODE" server/server.mjs
else
  open "http://localhost:$PORT"
fi
