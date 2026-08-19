// usage-board.js — store + 轮询 + localStorage 历史 + 渲染
//
// 数据架构：UI ← store ← Source 接口 ← HttpSource（真实，/api/*）/ MockSource（兜底）。
// store 只依赖 source 的三个 async 方法（fetchQuota / fetchTokenSeries / fetchApiStatus），
// 换数据源不改 UI 层。默认走本地 server 的真实数据；server 没起（首次 fetch 失败）
// 回退 MockSource，并在标题旁显示「MOCK 数据」pill 以便分辨。

import { createMockSource, CHANNELS } from './mock-data.js';
import { createHttpSource } from './real-source.js';

let source = createHttpSource('/api'); // 默认真实数据；启动时探测失败回退 mock

const params = new URLSearchParams(location.search);
const POLL_SEC = Math.max(2, parseInt(params.get('poll'), 10) || 30);

// 套餐选择器预设（Cost 面板点开可选，写回 server/config.json 不用手改文件）。
// ⚠️ 价格是撰写时的公开定价，各家会调价，选完发现不对就选「自定义」手动填。
// 只覆盖会按月订阅的渠道；DeepSeek/OpenRouter 是按量计费，没有套餐可选。
const PLAN_PRESETS = {
  claude: [
    { plan: 'Free', monthly: 0, currency: 'USD' },
    { plan: 'Pro', monthly: 20, currency: 'USD' },
    { plan: 'Max 5x', monthly: 100, currency: 'USD' },
    { plan: 'Max 20x', monthly: 200, currency: 'USD' },
  ],
  codex: [
    { plan: 'Free', monthly: 0, currency: 'USD' },
    { plan: 'Plus', monthly: 20, currency: 'USD' },
    { plan: 'Pro', monthly: 200, currency: 'USD' },
  ],
  kimi: [
    { plan: 'Free', monthly: 0, currency: 'CNY' },
    { plan: '会员', monthly: 199, currency: 'CNY' },
  ],
  grok: [
    { plan: 'Free', monthly: 0, currency: 'USD' },
    { plan: 'SuperGrok', monthly: 30, currency: 'USD' },
    { plan: 'SuperGrok Heavy', monthly: 300, currency: 'USD' },
  ],
};

async function postSubscription(channel, plan, monthly, currency) {
  try {
    const res = await fetch('/api/config/subscription', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, plan, monthly, currency }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await refresh(); // 立刻拉一轮新数据，套餐/ROI 马上反映出来
  } catch (e) {
    console.warn('保存套餐失败：', e.message);
    alert('保存失败，看下 server 是否还在跑');
  }
}

const QUOTA_HIST_KEY = 'aub:quota-history';
const TOKEN_HIST_KEY = 'aub:token-history';
const HIST_CAP_DAYS = 90;

const state = {
  tab: 'dashboard',
  range: 30,          // 趋势图天数：today/yesterday 特殊值或 3/7/30
  metric: 'total',    // total（含 cache）| auth（不含 cache）
  quota: null,        // fetchQuota() 结果
  token: null,        // fetchTokenSeries() 结果
  apiStatus: null,    // fetchApiStatus() 结果
  alerts: [],         // 由配额数据推导的告警
  fetchedAt: null,    // 最近一次配额查询时间戳
  resetDeadlines: {}, // channelId:label → Date.now() 截止时间戳（倒计时用）
  modelDrawerOpen: false, // 模型面板「其他 N 项」抽屉展开态（跨 poll 保持）
  projectDrawerOpen: false, // 项目面板抽屉展开态
  byProject: null,    // /api/by-project 结果（mock 源无此接口 → null，面板隐藏）
  costSummary: null,  // /api/cost-summary 结果
  heatmap: null,      // 84 天序列（热力图专用，固定含 cache 口径）
  chartGeom: null,    // 柱状图几何（hover 命中用）
};

// ============ 工具 ============
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function fmtDuration(sec) {
  if (sec == null || !isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function relTime(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function fmtTokens(n) {
  if (n >= 1e8) return (n / 1e8).toFixed(n >= 1e9 ? 1 : 2) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return String(Math.round(n));
}
function fmtNum(n) { return n.toLocaleString('en-US'); }

const CUR_SYM = { CNY: '¥', USD: '$' };
const curSym = (c) => CUR_SYM[c] || (c ? c + ' ' : '');
const STATUS_LABEL = { online: 'ONLINE', offline: 'OFFLINE', unconfigured: 'NO KEY', stale: 'STALE', dormant: '未运行' };
const statusLabel = (s) => STATUS_LABEL[s] || String(s || '').toUpperCase();

function barClass(pct) { return pct < 50 ? 'g' : pct <= 85 ? 'o' : 'r'; }

// 预计用尽秒数：按当前窗口内线性烧速外推。
// 若用尽点落在窗口剩余时间之外（即重置前烧不满），返回 null ——不会用尽。
function projectedHitSec(w) {
  if (w.usedPct == null) return null;
  if (w.usedPct >= 100) return 0;
  const elapsed = (w.timePct / 100) * w.windowSec;
  if (elapsed <= 0 || w.usedPct <= 0) return null;
  const rate = w.usedPct / elapsed; // pct / s
  const hit = (100 - w.usedPct) / rate;
  const remaining = ((100 - w.timePct) / 100) * w.windowSec;
  return hit <= remaining ? hit : null;
}

// ============ localStorage 历史 ============
function loadHist(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
}
function saveHist(key, arr) {
  localStorage.setItem(key, JSON.stringify(arr.slice(-HIST_CAP_DAYS)));
}
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function appendHistory() {
  if (!state.quota || !state.token) return;
  const day = todayKey();

  // 配额历史：按天聚合（一天只留最新一条快照）
  const qh = loadHist(QUOTA_HIST_KEY);
  const quotaSnap = { date: day, ts: Date.now(), channels: {} };
  for (const ch of state.quota.channels) {
    quotaSnap.channels[ch.id] = ch.kind === 'balance'
      ? { balance: ch.balance?.amount ?? null }
      : Object.fromEntries((ch.windows || []).map((w) => [w.label, w.usedPct]));
  }
  const qi = qh.findIndex((r) => r.date === day);
  if (qi >= 0) qh[qi] = quotaSnap; else qh.push(quotaSnap);
  saveHist(QUOTA_HIST_KEY, qh);

  // Token 历史：按天聚合（当日总量，随 poll 刷新）
  const th = loadHist(TOKEN_HIST_KEY);
  const tokenSnap = { date: day, ts: Date.now(), channels: {} };
  const t = state.token.today;
  tokenSnap.total = t.total; tokenSnap.auth = t.auth;
  const ti = th.findIndex((r) => r.date === day);
  if (ti >= 0) th[ti] = tokenSnap; else th.push(tokenSnap);
  saveHist(TOKEN_HIST_KEY, th);
}

// 首次运行：若无历史，用 mock 回填 30 天，让趋势类分析有底数
async function backfillHistoryIfEmpty() {
  if (loadHist(TOKEN_HIST_KEY).length > 0) return;
  const hist = await source.fetchTokenSeries({ days: 30, metric: 'total' });
  const th = hist.dates.map((date, i) => ({
    date, ts: Date.now(),
    channels: Object.fromEntries(hist.channels.map((c) => [c.id, c.daily[i]])),
  }));
  saveHist(TOKEN_HIST_KEY, th);
  const qh = hist.dates.map((date, i) => ({
    date, ts: Date.now(),
    channels: Object.fromEntries(hist.channels.map((c) => [c.id, { total: c.daily[i] }])),
  }));
  saveHist(QUOTA_HIST_KEY, qh);
}

// ============ 告警推导 ============
function deriveAlerts() {
  const alerts = [];
  if (!state.quota) return alerts;
  for (const ch of state.quota.channels) {
    // dormant（如 Antigravity 未运行）与未配置渠道不算异常，永不进告警横幅
    if (ch.status === 'dormant' || ch.status === 'unconfigured') continue;
    if (ch.status === 'offline') {
      alerts.push({ level: 'red', text: `${ch.name} 查询失败 OFFLINE` });
      continue;
    }
    if (ch.kind !== 'windows') continue;
    for (const w of ch.windows) {
      if (w.usedPct == null) continue;
      if (w.usedPct >= 95) {
        alerts.push({ level: 'red', text: `${ch.name} ${w.label} 已用尽` });
      } else {
        const hit = projectedHitSec(w);
        if (hit != null && hit <= 24 * 3600) {
          alerts.push({ level: 'yellow', text: `${ch.name} ${w.label} 约 ${fmtDuration(hit)} 后用尽` });
        }
      }
    }
  }
  return alerts;
}

// ============ 渲染：Dashboard ============
function renderClock() {
  const d = new Date();
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  const hh = d.getHours();
  const ap = hh < 6 ? '凌晨' : hh < 12 ? '上午' : hh < 14 ? '中午' : hh < 18 ? '下午' : '晚上';
  const h = hh % 12 || 12;
  const mm = String(d.getMinutes()).padStart(2, '0');
  $('#local-time').textContent = `本地 ${ap} ${String(h).padStart(2, '0')}:${mm} ${week}`;
}

function renderAlerts() {
  const box = $('#alert-banner');
  box.innerHTML = '';
  if (!state.alerts.length) return;
  const wrap = el('div', 'alert-box');
  wrap.appendChild(el('span', 'alert-count', `● ${state.alerts.length} 项异常`));
  for (const a of state.alerts) wrap.appendChild(el('span', `alert-chip ${a.level}`, a.text));
  box.appendChild(wrap);
}

function worstWindow(ch) {
  if (ch.kind !== 'windows') return null;
  const valid = ch.windows.filter((w) => w.usedPct != null);
  if (!valid.length) return null;
  return valid.reduce((a, b) => (b.usedPct > a.usedPct ? b : a));
}

function renderQuota() {
  // 顶部汇总 chips
  const chips = $('#quota-chips');
  chips.innerHTML = '';
  for (const ch of state.quota.channels) {
    let chip;
    if (ch.status === 'offline') {
      chip = el('span', 'q-chip bad', `${ch.name} OFFLINE`);
    } else if (ch.status === 'dormant') {
      chip = el('span', 'q-chip', `${ch.name} 未运行`);
    } else if (ch.status === 'unconfigured') {
      chip = el('span', 'q-chip', `${ch.name} 未配置`);
    } else if (ch.status === 'stale') {
      chip = el('span', 'q-chip warn', `${ch.name} 数据滞后`);
    } else if (ch.kind === 'balance') {
      chip = el('span', 'q-chip ok', `${ch.name} ${curSym(ch.balance?.currency)}${Math.floor(ch.balance?.amount ?? 0)}`);
    } else {
      const w = worstWindow(ch);
      if (w.usedPct >= 95) chip = el('span', 'q-chip bad', `${ch.name} 已用尽`);
      else if (w.usedPct >= 85) chip = el('span', 'q-chip warn', `${ch.name} 剩${Math.round(100 - w.usedPct)}%`);
      else chip = el('span', 'q-chip ok', `${ch.name} 剩${Math.round(100 - w.usedPct)}%`);
    }
    chips.appendChild(chip);
  }

  // 渠道区块
  const root = $('#quota-blocks');
  root.innerHTML = '';
  state.resetDeadlines = {};
  state.tickBase = {}; // 时间刻度竖线的锚点：fetch 时的 timePct + 时刻，tickLight 每秒平滑推进
  for (const ch of state.quota.channels) {
    const block = el('div', 'ch-block');

    const head = el('div', 'ch-head');
    head.appendChild(el('span', 'ch-name', ch.name));
    const right = el('span', 'ch-right');
    const last = el('span', 'ch-last js-rel', `上次查询 ${relTime(state.fetchedAt)}`);
    last.dataset.ts = state.fetchedAt;
    right.appendChild(last);
    right.appendChild(el('span', `pill ${ch.status}`, statusLabel(ch.status)));
    head.appendChild(right);
    block.appendChild(head);

    if (ch.kind === 'balance') {
      // 余额制（DeepSeek / OpenRouter）；note 如「未配置 key」，extra 如 key 维度用量
      const subText = ch.note ? `余额制 · ${ch.note}` : '余额制 · 按量计费';
      const subRow = el('div', 'ch-sub' + (ch.status === 'unconfigured' ? ' warn' : ''));
      subRow.appendChild(document.createTextNode(subText));
      if (ch.status === 'unconfigured' && ch.id === 'openrouter') {
        // 点一下告诉用户具体去哪拿 key、填在哪，别让「未配置」变成一个死胡同
        const help = el('span', 'ch-help-link', ' → 如何获取 key');
        help.style.cursor = 'pointer';
        help.style.textDecoration = 'underline';
        subRow.appendChild(help);
        const detail = el('div', 'ch-help-detail');
        detail.hidden = true;
        detail.innerHTML = '1. 打开 <a href="https://openrouter.ai/settings/provisioning-keys" target="_blank" rel="noopener">openrouter.ai/settings/provisioning-keys</a>，创建一个 Management Key（只读，选 Provisioning 类型即可，不用给推理权限）<br>' +
          '2. 复制 <code>server/.env.example</code> 为 <code>server/.env</code>，把 key 填进 <code>OPENROUTER_MANAGEMENT_KEY=</code> 后面<br>' +
          '3. 保存文件，配置是热加载的，不用重启 server，下一轮轮询就会生效';
        help.addEventListener('click', () => { detail.hidden = !detail.hidden; });
        block.appendChild(subRow);
        block.appendChild(detail);
      } else {
        block.appendChild(subRow);
      }
      if (ch.balance) {
        const line = el('div', 'balance-line');
        line.appendChild(el('span', 'cur', `余额 ${curSym(ch.balance.currency)}`));
        line.appendChild(document.createTextNode(fmtNum(ch.balance.amount)));
        block.appendChild(line);
      }
      if (ch.extra) block.appendChild(el('div', 'ch-sub', ch.extra));
    } else {
      // 副标题：取用量最高的窗口描述状态；渠道可带 note（如 Claude「限额为 ccusage 估算」）
      const w = worstWindow(ch);
      let sub, subCls = 'ch-sub';
      if (!w) {
        sub = ch.note || '暂无配额数据';
      } else if (w.usedPct >= 95) {
        sub = `${w.label} · 已用尽`; subCls += ' danger';
      } else {
        const hit = projectedHitSec(w);
        if (hit != null && hit <= 24 * 3600) { sub = `${w.label} · 约 ${fmtDuration(hit)} 后用尽`; subCls += ' danger'; }
        else if (w.usedPct >= 85) { sub = `${w.label} · 余量紧张`; subCls += ' warn'; }
        else sub = `${w.label} · 余量充足`;
      }
      if (ch.note && w) sub += ` · ${ch.note}`;
      block.appendChild(el('div', subCls, sub));

      for (const win of ch.windows) {
        if (win.usedPct == null) {
          const row = el('div', 'quota-row');
          row.appendChild(el('span', 'q-label', win.label));
          row.appendChild(el('span', 'q-nodata', '暂缺数据'));
          block.appendChild(row);
          continue;
        }
        const cls = barClass(win.usedPct);
        const row = el('div', 'quota-row');
        row.appendChild(el('span', 'q-label', win.label));

        const bar = el('div', 'q-bar');
        const fill = el('div', `q-fill ${cls}`);
        fill.style.width = `${Math.min(100, win.usedPct)}%`;
        bar.appendChild(fill);
        if (win.timePct != null) {
          const key = `${ch.id}:${win.label}`;
          state.tickBase[key] = { pct: win.timePct, ts: Date.now(), windowSec: win.windowSec };
          const tick = el('div', 'q-tick');
          tick.dataset.key = key;
          tick.style.left = `${Math.min(100, win.timePct)}%`;
          tick.title = `时间进度 ${win.timePct}%`;
          bar.appendChild(tick);
        }
        row.appendChild(bar);

        const meta = el('div', 'q-meta');
        meta.appendChild(el('span', `q-pct ${cls}`, `${win.usedPct}%`));
        if (win.resetInSec != null) {
          const key = `${ch.id}:${win.label}`;
          state.resetDeadlines[key] = Date.now() + win.resetInSec * 1000;
          const reset = el('span', 'q-reset js-reset', `${fmtDuration(win.resetInSec)} 后重置`);
          reset.dataset.key = key;
          meta.appendChild(reset);
        }
        row.appendChild(meta);
        block.appendChild(row);
      }
    }
    root.appendChild(block);
  }
}

function renderApiStatus() {
  const root = $('#api-status-rows');
  root.innerHTML = '';
  if (!state.apiStatus) return;
  for (const ch of state.apiStatus.channels) {
    const row = el('div', 'api-row');
    row.appendChild(el('span', 'api-name', ch.name));
    const label = ch.state === 'operational' ? 'OPERATIONAL' : statusLabel(ch.state);
    row.appendChild(el('span', `pill ${ch.state}`, label));
    if (ch.state !== 'unconfigured') row.appendChild(el('span', 'api-latency', `${ch.latencyMs} ms`));
    root.appendChild(row);
  }
}

// ============ 浮标（柱状图 / 热力图共用的 DOM tooltip） ============
function showTip(html, x, y) {
  const t = $('#aub-tooltip');
  t.innerHTML = html;
  t.hidden = false;
  const w = t.offsetWidth, h = t.offsetHeight;
  let left = x + 14, top = y + 14;
  if (left + w > window.innerWidth - 12) left = x - 14 - w; // 靠右缘翻到左侧
  if (top + h > window.innerHeight - 12) top = y - 14 - h;
  t.style.left = `${left}px`; t.style.top = `${top}px`;
}
function hideTip() { const t = $('#aub-tooltip'); if (t) t.hidden = true; }
function tipHtml(date, rows) {
  const total = rows.reduce((s, r) => s + r.tokens, 0);
  let h = `<div class="tip-date">${date}</div><div class="tip-total">共 ${fmtTokens(total)}</div>`;
  for (const r of rows) {
    h += `<div class="tip-row"><span class="tip-dot" style="background:${r.color}"></span>` +
      `<span class="tip-name">${r.name}</span><span class="tip-val">${fmtTokens(r.tokens)}</span></div>`;
  }
  return h;
}

// ============ 渲染：Token 用量 ============
function rangeParams() {
  if (state.range === 'today') return { days: 1, endOffset: 0 };
  if (state.range === 'yesterday') return { days: 1, endOffset: 1 };
  return { days: state.range, endOffset: 0 };
}
function rangeLabel() {
  return { today: '今日', yesterday: '昨日', 3: '近3日', 7: '近7日', 30: '近30日' }[state.range];
}

function renderSyncRow() {
  // dormant/unconfigured 渠道不计入同步分母（一个没在跑、一个没配置，都不是「同步失败」）
  const syncable = state.quota ? state.quota.channels.filter((c) => c.status !== 'dormant' && c.status !== 'unconfigured') : [];
  const total = syncable.length;
  const ok = syncable.filter((c) => c.status === 'online' || c.status === 'stale').length;
  $('#sync-row').innerHTML = '';
  const row = $('#sync-row');
  row.appendChild(el('span', 'dot', '●'));
  row.appendChild(document.createTextNode(`${ok}/${total} 渠道同步正常 · 最近同步 `));
  const t = el('span', 'js-rel', relTime(state.fetchedAt));
  t.dataset.ts = state.fetchedAt;
  row.appendChild(t);
}

function renderOverview() {
  const t = state.token.today;
  $('#today-date').textContent = `今日 · ${t.date}`;
  $('#ov-total').textContent = fmtTokens(t.total);
  const b = t.breakdown;
  $('#ov-total-breakdown').textContent =
    `input ${fmtTokens(b.input)} + output ${fmtTokens(b.output)} + cache read ${fmtTokens(b.cacheRead)} + write ${fmtTokens(b.cacheWrite)}`;
  $('#ov-total-ref').textContent = `昨日 ${fmtTokens(t.yesterdayTotal)} · 近 7 日均 ${fmtTokens(t.weekAvg)}`;
  $('#ov-auth').textContent = fmtTokens(t.auth);
  $('#ov-auth-breakdown').textContent = `input ${fmtTokens(b.input)} + output ${fmtTokens(b.output)}`;
}

function renderLegend() {
  const lg = $('#chart-legend');
  lg.innerHTML = '';
  for (const ch of state.token.channels) {
    const item = el('span', 'lg-item');
    const dot = el('span', 'lg-dot');
    dot.style.background = ch.color;
    item.appendChild(dot);
    item.appendChild(document.createTextNode(ch.name));
    lg.appendChild(item);
  }
}

function drawChart() {
  const canvas = $('#trend-canvas');
  const data = state.token;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  // 坐标轴/网格/文字颜色跟随当前主题（CSS 变量）
  const cs = getComputedStyle(document.documentElement);
  const gridCol = cs.getPropertyValue('--chart-grid').trim() || '#1f2430';
  const axisCol = cs.getPropertyValue('--chart-axis').trim() || '#8b93a7';

  const padL = 46, padR = 10, padT = 10, padB = 40;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const days = data.dates.length;

  // 每日堆叠总量 → Y 轴上限（亿）
  const totals = data.dates.map((_, i) => data.channels.reduce((s, c) => s + c.daily[i], 0));
  const maxYi = Math.max(...totals) / 1e8;
  const step = Math.max(1, Math.ceil(maxYi / 4));
  const yMax = step * 4;

  ctx.font = '11px system-ui';
  // Y 轴网格与刻度
  ctx.strokeStyle = gridCol;
  ctx.fillStyle = axisCol;
  ctx.textAlign = 'right';
  ctx.lineWidth = 1;
  for (let v = 0; v <= yMax; v += step) {
    const y = padT + plotH - (v / yMax) * plotH;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(v === 0 ? '0' : `${v}亿`, padL - 8, y + 4);
  }

  // 堆叠柱（几何存下供 hover 命中）
  const slot = plotW / days;
  const barW = Math.max(2, Math.min(26, slot * 0.6));
  const bars = [];
  for (let i = 0; i < days; i++) {
    const cx = padL + slot * i + slot / 2;
    bars.push({ x: cx - barW / 2, w: barW, i });
    let yBase = padT + plotH;
    for (const ch of data.channels) {
      const h = (ch.daily[i] / 1e8 / yMax) * plotH;
      if (h <= 0) continue;
      ctx.fillStyle = ch.color;
      ctx.fillRect(cx - barW / 2, yBase - h, barW, h);
      yBase -= h;
    }
  }
  state.chartGeom = { bars, padT, plotH };

  // X 轴日期（斜排，稀疏标注）
  ctx.fillStyle = axisCol;
  ctx.textAlign = 'right';
  const labelEvery = Math.max(1, Math.ceil(days / 8));
  for (let i = 0; i < days; i++) {
    if (i % labelEvery !== 0 && i !== days - 1) continue;
    const cx = padL + slot * i + slot / 2;
    ctx.save();
    ctx.translate(cx, padT + plotH + 8);
    ctx.rotate(-Math.PI / 6);
    ctx.fillText(data.dates[i].slice(5), 0, 0);
    ctx.restore();
  }
}

// 每日用量热力图（GitHub/Codex 风格：一年视图、周一起始、格子铺满整宽、月份标签在底部、
// 末尾两列未来周用虚线空格区分；固定「含 cache」口径，与范围选择器解耦）
const HM_WEEKS = 52, HM_FUTURE_COLS = 2;

function renderHeatmap() {
  const root = $('#heatmap');
  if (!root) return;
  root.innerHTML = '';
  const hm = state.heatmap;
  if (!hm || !hm.dates?.length) return;

  const totals = {};
  hm.dates.forEach((d, i) => { totals[d] = hm.channels.reduce((s, c) => s + c.daily[i], 0); });
  const max = Math.max(1, ...Object.values(totals));
  // 平方根刻度（6 档）：log 会把高端压平（实测 2.3/5.6/11.7 亿同档），sqrt 归一化后
  // 0.42/0.66/0.95 分落三档；低端 100 万 →0.009 落最低非零档，0 仍是 0。
  const LV_ALPHA = [0, 0.12, 0.28, 0.48, 0.70, 1.0];
  const levelOf = (v) => (v <= 0 ? 0 : 1 + Math.min(LV_ALPHA.length - 2, Math.floor(Math.sqrt(v / max) * (LV_ALPHA.length - 1))));

  // 格子尺寸：列 flex 均分 + aspect-ratio 正方形，随面板宽度自适应（无需 JS 计算）
  const cols = HM_WEEKS + HM_FUTURE_COLS;

  const todayD = new Date(); todayD.setHours(0, 0, 0, 0);
  const thisMonday = new Date(todayD);
  thisMonday.setDate(thisMonday.getDate() - ((thisMonday.getDay() + 6) % 7));
  const start = new Date(thisMonday);
  start.setDate(start.getDate() - (HM_WEEKS - 1) * 7);

  const dateStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  let prevMonth = null;
  for (let ci = 0; ci < cols; ci++) {
    const monday = new Date(start);
    monday.setDate(monday.getDate() + ci * 7);
    const isFuture = monday > thisMonday; // 未来周整列
    const col = el('div', 'hm-col');
    for (let dow = 0; dow < 7; dow++) {
      const d = new Date(monday); d.setDate(d.getDate() + dow);
      const cell = el('div', 'hm-cell');
      if (isFuture || d > todayD) {
        cell.classList.add('hm-future'); // 虚线空格，hover 显示「未来」
        cell.dataset.future = '1';
      } else {
        const ds = dateStr(d);
        const v = totals[ds] || 0; // 扫描窗口之前的日子 = 真实的 0
        const lv = levelOf(v);
        if (lv > 0) cell.style.background = `color-mix(in srgb, var(--blue) ${LV_ALPHA[lv] * 100}%, var(--q-track))`;
        cell.dataset.date = ds;
        cell.dataset.tokens = v;
      }
      col.appendChild(cell);
    }
    // 月份标签在底部：列首日与上一列不同月才标
    const mon = monday.getMonth() + 1;
    col.appendChild(el('div', 'hm-label', mon !== prevMonth ? `${mon}月` : ''));
    prevMonth = mon;
    root.appendChild(col);
  }
}

function renderChartSummary() {  const d = state.token;
  const metricLabel = d.metric === 'auth' ? '权威量（不含 cache）' : '总处理量（含 cache）';
  $('#chart-summary').textContent =
    `${d.dates[0]} 至 ${d.dates[d.dates.length - 1]} · ${metricLabel} · ` +
    `等效估值 $${fmtNum(d.estimateUSD)}（部分），非订阅账单`;
}

function renderHbars(rootSel, rows, colorOf, base = null) {
  const root = typeof rootSel === 'string' ? $(rootSel) : rootSel;
  const max = base?.max ?? Math.max(...rows.map((r) => r.tokens), 1);
  const total = base?.total ?? (rows.reduce((s, r) => s + r.tokens, 0) || 1);
  for (const r of rows) {
    const wrap = el('div', 'hbar-row');
    if (r.title) wrap.title = r.title;
    const head = el('div', 'hbar-head');
    const nameEl = el('span', 'hbar-name', r.name);
    if (r.tag) nameEl.appendChild(el('span', 'hbar-tag', r.tag)); // 如「已合并 2 个目录」
    head.appendChild(nameEl);
    const val = el('span', 'hbar-val');
    val.appendChild(document.createTextNode(fmtTokens(r.tokens)));
    val.appendChild(el('span', 'pct', `${(r.tokens / total * 100).toFixed(1)}%`));
    head.appendChild(val);
    wrap.appendChild(head);
    const track = el('div', 'hbar-track');
    const fill = el('div', 'hbar-fill');
    fill.style.width = `${(r.tokens / max) * 100}%`;
    fill.style.background = colorOf(r);
    track.appendChild(fill);
    wrap.appendChild(track);
    root.appendChild(wrap);
  }
}

// 通用「topN 横条 + 其他 N 项抽屉」渲染（模型/项目面板共用）
function renderBarsWithDrawer(rootSel, rows, drawerOpen, onToggle) {
  const root = $(rootSel);
  root.innerHTML = '';
  const TOP = 6;
  const top = rows.slice(0, TOP);
  const rest = rows.slice(TOP);
  const base = {
    max: Math.max(...rows.map((r) => r.tokens), 1),
    total: rows.reduce((s, r) => s + r.tokens, 0) || 1,
  };
  renderHbars(root, top, (r) => r.color, base);

  if (!rest.length) return;
  const restTokens = rest.reduce((s, r) => s + r.tokens, 0);
  const toggle = el('div', 'hbar-row hbar-toggle' + (drawerOpen ? ' open' : ''));
  toggle.setAttribute('role', 'button');
  const head = el('div', 'hbar-head');
  head.appendChild(el('span', 'hbar-name', `其他 ${rest.length} 项`));
  const val = el('span', 'hbar-val');
  val.appendChild(document.createTextNode(fmtTokens(restTokens)));
  val.appendChild(el('span', 'pct', `${(restTokens / base.total * 100).toFixed(1)}%`));
  val.appendChild(el('span', 'chev', '›'));
  head.appendChild(val);
  toggle.appendChild(head);
  const track = el('div', 'hbar-track');
  const fill = el('div', 'hbar-fill');
  fill.style.width = `${(restTokens / base.max) * 100}%`;
  fill.style.background = 'var(--bar-other)';
  track.appendChild(fill);
  toggle.appendChild(track);
  toggle.addEventListener('click', onToggle);
  root.appendChild(toggle);

  const drawer = el('div', 'model-drawer' + (drawerOpen ? ' open' : ''));
  const inner = el('div', 'model-drawer-inner');
  renderHbars(inner, rest, (r) => r.color, base);
  drawer.appendChild(inner);
  root.appendChild(drawer);
}

function renderDuoPanels() {
  const d = state.token;
  $('#agent-bars').innerHTML = '';
  renderHbars('#agent-bars', d.channels.map((c) => ({ name: c.name, tokens: c.total, id: c.id })),
    (r) => d.channels.find((c) => c.id === r.id).color);

  // 模型面板
  const colorOf = (m) => (d.channels.find((c) => c.id === m.channel) || {}).color || 'var(--bar-other)';
  renderBarsWithDrawer('#model-bars',
    d.models.map((m) => ({ name: m.name, tokens: m.tokens, color: colorOf(m) })),
    state.modelDrawerOpen,
    () => { state.modelDrawerOpen = !state.modelDrawerOpen; renderDuoPanels(); });
}

// 项目面板：按工作目录聚合（OpenRouter 无项目维度，server 侧已排除）
function renderProjectPanel() {
  const panel = $('#project-bars')?.closest('.panel');
  if (!panel) return;
  if (!state.byProject || !state.byProject.length) { panel.hidden = true; return; }
  panel.hidden = false;
  renderBarsWithDrawer('#project-bars',
    state.byProject.map((p) => ({
      name: p.project,
      tag: p.mergedFrom ? `已合并 ${p.mergedFrom.length} 个目录` : null,
      title: (p.mergedFrom || [p.path]).join('\n'),
      tokens: p.tokens,
      color: 'var(--blue)',
    })),
    state.projectDrawerOpen,
    () => { state.projectDrawerOpen = !state.projectDrawerOpen; renderProjectPanel(); });
}

// 费用预估与套餐回报
function renderCostPanel() {
  const panel = $('#cost-panel');
  if (!panel) return;
  const cs = state.costSummary;
  if (!cs || !cs.channels.length) { panel.hidden = true; return; }
  panel.hidden = false;

  const s = cs.summary;
  $('#cost-summary-line').textContent =
    `近 ${cs.days} 日等效 $${fmtNum(s.totalEquivUSD)} · 订阅折合约 $${fmtNum(s.totalMonthlyUSD)}` +
    (s.roi != null ? ` · 综合回报 ${s.roi}×` : '');
  $('#cost-note').textContent =
    `按官方刊例价估算 · ROI 统一美元口径（CNY 按汇率 ${cs.cnyUsdRate} 折算）· 价格表与套餐金额见 server/config.json`;

  const root = $('#cost-rows');
  root.innerHTML = '';
  for (const c of cs.channels) {
    const row = el('div', 'cost-row');
    row.appendChild(el('span', 'cost-name', c.name));

    const equiv = el('span', 'cost-equiv');
    const val = c.actualUSD != null ? c.actualUSD : c.equivUSD;
    equiv.appendChild(document.createTextNode(`$${fmtNum(Math.round(val))}`));
    if (c.priced === false) equiv.appendChild(el('span', 'cost-tilde', '~')); // 有模型用了 fallback 价
    row.appendChild(equiv);

    const presets = PLAN_PRESETS[c.id];
    if (presets && source.name === 'http') {
      // 可选套餐：列出预设 + 自定义，选完直接写回 config.json，不用去改文件
      const sel = el('select', 'cost-sub cost-sub-select');
      const cur = c.subscription;
      let matched = false;
      for (const p of presets) {
        const opt = document.createElement('option');
        opt.value = `${p.plan}|${p.monthly}|${p.currency}`;
        opt.textContent = p.monthly > 0 ? `${p.plan} ${curSym(p.currency)}${p.monthly}/月` : `${p.plan} $0/月`;
        if (cur && cur.plan === p.plan && cur.monthly === p.monthly && cur.currency === p.currency) {
          opt.selected = true; matched = true;
        }
        sel.appendChild(opt);
      }
      const customOpt = document.createElement('option');
      customOpt.value = '__custom__';
      customOpt.textContent = cur && !matched
        ? `${cur.plan} ${curSym(cur.currency)}${cur.monthly}/月（自定义）`
        : '自定义…';
      if (!matched) customOpt.selected = true;
      sel.appendChild(customOpt);
      sel.addEventListener('change', () => {
        if (sel.value === '__custom__') {
          const plan = prompt('套餐名称？', cur?.plan || '自定义');
          if (plan == null) { renderCostPanel(); return; } // 取消，还原选择
          const monthlyStr = prompt('每月多少钱（数字）？', cur?.monthly ?? '0');
          const monthly = Number(monthlyStr);
          if (!plan || !Number.isFinite(monthly) || monthly < 0) { renderCostPanel(); return; }
          const currency = confirm('按 CNY 计价？（取消 = USD）') ? 'CNY' : 'USD';
          postSubscription(c.id, plan, monthly, currency);
        } else {
          const [plan, monthly, currency] = sel.value.split('|');
          postSubscription(c.id, plan, Number(monthly), currency);
        }
      });
      row.appendChild(sel);
    } else {
      const sub = el('span', 'cost-sub');
      if (c.subscription) {
        sub.textContent = c.subscription.monthly > 0
          ? `${c.subscription.plan} ${curSym(c.subscription.currency)}${c.subscription.monthly}/月`
          : `${c.subscription.plan} $0/月`;
      } else sub.textContent = c.note || '按量计费';
      row.appendChild(sub);
    }

    const roi = el('span', 'cost-roi');
    if (c.roi != null) {
      roi.appendChild(el('span', 'cost-roi-num', `${c.roi}×`));
    } else if (c.subscription && c.subscription.monthly === 0) {
      roi.appendChild(el('span', 'cost-roi-num dim', '∞'));
    } else {
      roi.appendChild(el('span', 'cost-roi-num dim', '—'));
    }
    row.appendChild(roi);
    root.appendChild(row);
  }
}

// ============ 轻量每秒刷新：相对时间 + 重置倒计时 ============
function tickLight() {
  renderClock();
  document.querySelectorAll('.js-rel').forEach((n) => {
    const ts = +n.dataset.ts;
    n.textContent = n.textContent.includes('上次查询')
      ? `上次查询 ${relTime(ts)}` : relTime(ts);
  });
  document.querySelectorAll('.js-reset').forEach((n) => {
    const dl = state.resetDeadlines[n.dataset.key];
    if (dl) n.textContent = `${fmtDuration((dl - Date.now()) / 1000)} 后重置`;
  });
  // 时间刻度竖线平滑推进：两次轮询间按窗口流逝速度前进（stale 渠道照推——时间不静止）
  document.querySelectorAll('.q-tick[data-key]').forEach((n) => {
    const b = state.tickBase?.[n.dataset.key];
    if (b && b.windowSec) {
      const pct = Math.min(100, b.pct + ((Date.now() - b.ts) / 1000 / b.windowSec) * 100);
      n.style.left = `${pct}%`;
      n.title = `时间进度 ${pct.toFixed(1)}%`;
    }
  });
}

// ============ 主流程 ============
function renderAll() {
  renderClock();
  renderAlerts();
  renderQuota();
  renderApiStatus();
  if (state.token) {
    renderSyncRow();
    renderOverview();
    renderHeatmap();
    renderLegend();
    drawChart();
    renderChartSummary();
    renderDuoPanels();
    renderProjectPanel();
    renderCostPanel();
  }
}

async function refresh() {
  try {
    const rp = rangeParams();
    const [quota, apiStatus, token] = await Promise.all([
      source.fetchQuota(),
      source.fetchApiStatus(),
      source.fetchTokenSeries({ days: rp.days, endOffset: rp.endOffset, metric: state.metric }),
    ]);
    // 项目维度只有真实源有（mock 无此接口 → 面板隐藏）
    state.byProject = source.fetchByProject
      ? await source.fetchByProject({ days: rp.days, endOffset: rp.endOffset, metric: state.metric }).catch(() => null)
      : null;
    state.costSummary = source.fetchCostSummary
      ? await source.fetchCostSummary({ days: rp.days }).catch(() => null)
      : null;
    // 热力图独立取一年（固定含 cache 口径，与范围选择器解耦；扫描窗口之前的日子为 0 空格）
    state.heatmap = await source.fetchTokenSeries({ days: 375, metric: 'total' }).catch(() => null);
    state.quota = quota;
    state.apiStatus = apiStatus;
    state.token = token;
    state.fetchedAt = quota.fetchedAt;
    state.alerts = deriveAlerts();
    appendHistory();
    renderAll();
  } catch (e) {
    // 单轮失败保留旧数据，下轮再试（server 重启、网络抖动都不应打白页面）
    console.warn('refresh 失败，保留旧数据：', e.message);
  }
}

// ============ 主题切换 ============
// data-theme 已在 index.html 的内联脚本里于首帧前定下（localStorage > 系统偏好），
// 这里只负责交互切换：写回 <html data-theme> + 持久化 + 重绘 canvas（图表色随主题）。
const THEME_KEY = 'aub:theme';

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  if (state.token) drawChart(); // 坐标轴/网格色从 CSS 变量读取，需重绘
}
function toggleTheme() {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#tab-dashboard').hidden = tab !== 'dashboard';
  $('#tab-token').hidden = tab !== 'token';
  if (tab === 'token' && state.token) {
    // tab 从 hidden 恢复后 canvas 需要按新尺寸重绘
    drawChart();
  }
}

// 事件绑定
document.querySelectorAll('.tab-btn').forEach((b) =>
  b.addEventListener('click', () => switchTab(b.dataset.tab)));
$('#range-pills').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('#range-pills button').forEach((b) => b.classList.toggle('active', b === btn));
  state.range = btn.dataset.range === 'today' ? 'today' : btn.dataset.range === 'yesterday' ? 'yesterday' : +btn.dataset.range;
  await refresh();
});
$('#metric-select').addEventListener('change', async (e) => {
  state.metric = e.target.value;
  await refresh();
});
$('#theme-toggle').addEventListener('click', toggleTheme);
window.addEventListener('resize', () => {
  if (state.token && state.tab === 'token') { drawChart(); renderHeatmap(); } // 格子尺寸随面板宽度重算
});
window.addEventListener('scroll', hideTip, { passive: true });

// 柱状图 hover 浮标：命中检测用 drawChart 存下的几何
const trendCanvas = $('#trend-canvas');
trendCanvas.addEventListener('mousemove', (e) => {
  const g = state.chartGeom;
  if (!g || !state.token) return;
  const rect = trendCanvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  if (my < g.padT || my > g.padT + g.plotH) { hideTip(); return; }
  const b = g.bars.find((b) => mx >= b.x && mx <= b.x + b.w);
  if (!b) { hideTip(); return; }
  const d = state.token;
  const rows = d.channels
    .map((c) => ({ color: c.color, name: c.name, tokens: c.daily[b.i] }))
    .filter((r) => r.tokens > 0)
    .sort((a, z) => z.tokens - a.tokens);
  showTip(tipHtml(d.dates[b.i], rows), e.clientX, e.clientY);
});
trendCanvas.addEventListener('mouseleave', hideTip);

// 热力图 hover 浮标（事件委托；单值，不拆分渠道；未来格显示「未来」，空格显示「无数据」）
$('#heatmap').addEventListener('mouseover', (e) => {
  const cell = e.target.closest('.hm-cell');
  if (!cell) return;
  if (cell.dataset.future) {
    showTip('<div class="tip-date">未来</div>', e.clientX, e.clientY);
    return;
  }
  if (!cell.dataset.date) return;
  const v = +cell.dataset.tokens;
  const html = v > 0
    ? tipHtml(cell.dataset.date, [{ color: 'var(--blue)', name: '总处理量', tokens: v }])
    : `<div class="tip-date">${cell.dataset.date}</div><div class="tip-total">无数据（0）</div>`;
  showTip(html, e.clientX, e.clientY);
});
$('#heatmap').addEventListener('mouseleave', hideTip);

// probe 钩子
window.__board = { state, refresh, switchTab, setTheme };

// 启动：探测本地 server 的真实接口，失败回退 MockSource 并显示「MOCK 数据」pill。
// 回退不是终态：mock 模式下每 15s 重试真实源，成功即切回并摘 pill。
const httpSource = source;
(async () => {
  try {
    await Promise.race([
      source.fetchQuota(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout')), 10_000)),
    ]);
  } catch {
    source = createMockSource();
    state.usingMock = true;
    $('#mock-pill').hidden = false;
    setInterval(async () => {
      if (!state.usingMock) return;
      try {
        await httpSource.fetchQuota();
        source = httpSource;
        state.usingMock = false;
        $('#mock-pill').hidden = true;
        console.info('[api-usage-board] 已切回真实数据源');
        await refresh();
      } catch { /* server 仍未就绪，下轮再试 */ }
    }, 15_000);
  }
  await backfillHistoryIfEmpty();
  await refresh();
  setInterval(refresh, POLL_SEC * 1000);
  setInterval(tickLight, 1000);
})();
