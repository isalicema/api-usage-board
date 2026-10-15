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

# 只认「正在监听」：服务被杀后，打开着看板的浏览器标签页还握着半关闭连接（CLOSE_WAIT），
# `lsof -i :端口` 会把它们也列出来，旧写法据此误判成「服务在跑」，只开浏览器、不启动服务。
if ! lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && ! /usr/sbin/lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  (
    # 首开时 server 首轮扫描大日志要十几秒，等 /api/health 就绪再开浏览器（上限 60s）
    for i in $(seq 1 60); do
      /usr/bin/curl -sf -m 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
      sleep 1
    done
    open "http://localhost:$PORT"
  ) &
  # 服务日志落盘：快捷指令用 `nohup … >/dev/null` 启动时 stdout 会被丢弃，出问题就没有任何线索可查。
  # 所以由脚本自己 tee 进文件——终端里照常能看到，文件里也留一份。超过 2MB 的旧日志启动时轮转成 server.log.1。
  LOGDIR="$HOME/Library/Logs/api-usage-board"; LOG="$LOGDIR/server.log"
  mkdir -p "$LOGDIR"
  [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt 2097152 ] && mv -f "$LOG" "$LOG.1"
  echo "===== $(date '+%F %T') 启动 =====" >> "$LOG"
  "$NODE" server/server.mjs 2>&1 | tee -a "$LOG"
else
  open "http://localhost:$PORT"
fi
