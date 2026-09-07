// _probe/shots.mjs — api-usage-board 验证脚本（真实数据版）
// 截图：tab1/tab2 × dark/light + tab2 抽屉展开态 × dark/light（共 6 张）
// 断言：真实数据、模型抽屉展开/收起、Kimi stale 降级（构造失败）、无 sk- 泄露等。
//
// 服务策略：
//   - 先探测 127.0.0.1:8177（serve.command 的常驻端口）：已在跑 → 复用，跑完【不停】。
//   - 8177 空闲 → 自起临时 node server（PORT=8179），跑完自行停掉。
// 注意：首轮数据扫描（ccusage / codex 大日志）较慢，API 预热最长等 3 分钟。
// 用法：node _probe/shots.mjs
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

// 输出路径由脚本自身位置推导（公约：禁止 new URL(...).pathname）
const moduleRoot = fileURLToPath(new URL('../', import.meta.url));
const shotsDir = fileURLToPath(new URL('../shots/', import.meta.url));
fs.mkdirSync(shotsDir, { recursive: true });

const RESIDENT_PORT = 8177;
const TEMP_PORT = 8179;

async function httpOk(port, path = '/', timeoutMs = 3000) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}
async function apiJson(port, path, timeoutMs = 180_000) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
  return r.json();
}

let port = RESIDENT_PORT;
let ownServer = null;
if (await httpOk(RESIDENT_PORT)) {
  console.log(`· 检测到 127.0.0.1:${RESIDENT_PORT} 已有服务，复用（跑完不停）`);
} else {
  port = TEMP_PORT;
  ownServer = spawn(process.execPath, ['server/server.mjs'], {
    cwd: moduleRoot, stdio: 'ignore', env: { ...process.env, PORT: String(TEMP_PORT) },
  });
  for (let i = 0; i < 60 && !(await httpOk(port)); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await httpOk(port))) {
    console.error(`✗ 临时 server :${port} 启动失败`);
    ownServer.kill();
    process.exit(1);
  }
  console.log(`· 8177 空闲，自起临时 node server :${port}（跑完自停）`);
}

let exitCode = 0;
try {
  // —— API 预热与真实数据断言 ——
  console.log('· 预热 /api/quota（首轮 ccusage/大日志扫描可能较慢）…');
  let quota = await apiJson(port, '/api/quota');
  // claude 的 ccusage 预热最慢，离线时等后台刷新后重试
  for (let i = 0; i < 12 && quota.channels.some((c) => c.status === 'offline'); i++) {
    await new Promise((r) => setTimeout(r, 15_000));
    quota = await apiJson(port, '/api/quota');
  }
  const byId = Object.fromEntries(quota.channels.map((c) => [c.id, c]));
  const check = (ok, msg) => console.log(`${ok ? '✓' : '✗'} ${msg}`);

  check(quota.channels.length === 8, `/api/quota 返回 ${quota.channels.length}/8 渠道`);

  const codex7d = (byId.codex?.windows || []).find((w) => w.label === '7天');
  check(typeof codex7d?.usedPct === 'number' && codex7d.usedPct !== 99,
    `Codex 7天窗口为真实数据（usedPct=${codex7d?.usedPct}，非 mock 的 99）`);
  check(byId.codex?.source === 'wham', `Codex 配额来自 wham 直连（source=${byId.codex?.source}）`);

  const kimiLabels = (byId.kimi?.windows || []).map((w) => w.label).sort().join('+');
  check(kimiLabels === '5小时+7天', `Kimi 窗口齐全（${kimiLabels || '无'}）`);

  check(typeof byId.deepseek?.balance?.amount === 'number' && byId.deepseek.balance.amount !== 1037.84,
    `DeepSeek 余额为真实数据（¥${byId.deepseek?.balance?.amount}，非 mock 的 1037.84）`);

  check(byId.claude?.status === 'online' && (byId.claude?.windows || []).length > 0,
    `Claude 渠道在线（note=${byId.claude?.note || '无'}）`);
  check(byId.claude?.source === 'direct', `Claude 配额来自官方直连（source=${byId.claude?.source}）`);

  // OpenRouter：有 key → online + 余额；无 key → unconfigured + 「未配置 key」，两种都算降级路径正确
  const orq = byId.openrouter;
  const orOk = orq && (
    (orq.status === 'online' && typeof orq.balance?.amount === 'number') ||
    (orq.status === 'unconfigured' && orq.note === '未配置 key')
  );
  check(!!orOk, `OpenRouter 渠道存在且状态合法（status=${orq?.status}${orq?.note ? '，' + orq.note : ''}${orq?.balance ? '，余额 $' + orq.balance.amount : ''}）`);

  // Grok：online（direct/log）/ stale 必须有窗口；offline 必须带原因 note（凭证过期/未安装等）
  const gq = byId.grok;
  check(gq && (
    (['online', 'stale'].includes(gq.status) && (gq.windows || []).length > 0) ||
    (gq.status === 'offline' && !!gq.note)
  ),
    `Grok 渠道状态合法（status=${gq?.status} source=${gq?.source || '—'} ${(gq?.windows || []).map((w) => w.label + ':' + w.usedPct + '%').join(' ')}${gq?.note ? '，' + gq.note : ''}）`);

  // Cursor：online（月账期窗口）或凭证过期 offline（带指引副标）
  const cq = byId.cursor;
  check(cq && (cq.status === 'online' || (cq.status === 'offline' && (cq.note || '').includes('Cursor'))),
    `Cursor 渠道状态合法（status=${cq?.status} ${(cq?.windows || []).map((w) => w.label + ':' + w.usedPct + '%').join(' ')}${cq?.note ? '，' + cq.note : ''}）`);

  // Antigravity：dormant（agy 未运行，常态）或 online
  const aq = byId.antigravity;
  check(aq && ['dormant', 'online'].includes(aq.status),
    `Antigravity 渠道状态合法（status=${aq?.status}，${aq?.note || ''}）`);

  const series = await apiJson(port, '/api/token-series?days=30&metric=total');
  const totalPts = series.channels.reduce((s, c) => s + c.daily.filter((v) => v > 0).length, 0);
  check(totalPts > 0, `/api/token-series?days=30 有非零数据点（${totalPts} 个非零天）`);
  const seriesIds = series.channels.map((c) => c.id).sort();
  check(!seriesIds.includes('cursor') && !seriesIds.includes('antigravity') && seriesIds.includes('grok'),
    `tokenData:false 渠道不进 Token tab（序列渠道：${seriesIds.join('/')}）`);

  // 按项目聚合
  const byProj = await apiJson(port, '/api/by-project?days=30&metric=total');
  check(byProj.length > 0,
    `/api/by-project 非空（top3：${byProj.slice(0, 3).map((p) => `${p.project} ${(p.tokens / 1e8).toFixed(1)}亿`).join(' / ')}）`);
  // 别名归并：仅在 server/config.json 配置了 projectAliases 时才有意义，默认留空不测
  const hasAliasConfig = byProj.some((p) => (p.mergedFrom || []).length > 0);
  if (hasAliasConfig) {
    const mergedRow = byProj.find((p) => (p.mergedFrom || []).length > 0);
    check(!!mergedRow, `项目别名归并生效（${mergedRow.project} mergedFrom=${mergedRow.mergedFrom.length} 个目录）`);
  } else {
    check(true, '项目别名归并：未配置 projectAliases，跳过（正常，见 server/config.json 说明）');
  }

  // 费用预估：数值非负、OpenRouter 真实花费、codex equiv 与 top 模型合计内部一致
  const cost = await apiJson(port, '/api/cost-summary?days=30');
  const costCh = cost.channels;
  const allNonNeg = costCh.every((c) => (c.equivUSD ?? c.actualUSD ?? 0) >= 0);
  const codexC = costCh.find((c) => c.id === 'codex');
  const codexModelSum = (codexC?.byModelTop || []).reduce((s, m) => s + m.cost, 0);
  const codexConsistent = codexC && codexC.equivUSD > 0 && codexModelSum <= codexC.equivUSD + 0.01 && codexModelSum > codexC.equivUSD * 0.5;
  check(allNonNeg && codexConsistent,
    `cost-summary 数值合法（codex equiv=$${codexC?.equivUSD} roi=${codexC?.roi}×，top 模型合计=$${codexModelSum.toFixed(0)}）`);
  const orC = costCh.find((c) => c.id === 'openrouter');
  check(orC && typeof orC.actualUSD === 'number' && orC.actualUSD >= 0,
    `OpenRouter 用真实花费（actualUSD=$${orC?.actualUSD}）`);
  console.log(`  · 汇总：近${cost.days}日等效 $${cost.summary.totalEquivUSD} vs 订阅折合 $${cost.summary.totalMonthlyUSD}，综合回报 ${cost.summary.roi}×`);

  // —— 页面验证 ——
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  const errors = [];
  const consoleTexts = [];
  page.on('console', (m) => {
    consoleTexts.push(m.text());
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__board && window.__board.state.quota && window.__board.state.token, null, { timeout: 120_000 });
  await page.waitForTimeout(400);

  // 时间刻度竖线平滑推进：隔 3s 读同一 tick 的 left，应有可测增量（3s/5h ≈ 0.017%）
  const tickProbe = async () => page.evaluate(() => {
    const t = document.querySelector('.q-tick[data-key]');
    return t ? parseFloat(t.style.left) : null;
  });
  const tick1 = await tickProbe();
  await page.waitForTimeout(3000);
  const tick2 = await tickProbe();
  check(tick1 != null && tick2 > tick1, `时间刻度竖线平滑推进（${tick1}% → ${tick2}%）`);

  async function shot(name, { fullPage = true } = {}) {
    // hover 浮标是 position:fixed，fullPage 拼接截图会丢——浮标截图用视口模式
    await page.screenshot({ path: shotsDir + name, fullPage });
    console.log(`✓ 截图 → shots/${name}`);
  }

  await shot('tab1-dark.png');
  await page.evaluate(() => window.__board.switchTab('token'));
  await page.waitForTimeout(300);
  await shot('tab2-dark.png');
  await page.evaluate(() => window.__board.setTheme('light'));
  await page.waitForTimeout(300);
  await shot('tab2-light.png');
  await page.evaluate(() => window.__board.switchTab('dashboard'));
  await page.waitForTimeout(300);
  await shot('tab1-light.png');

  // —— 抽屉：模型 + 项目两个面板都展开，截图 + 断言 ——
  await page.evaluate(() => window.__board.switchTab('token'));
  await page.waitForTimeout(200);
  const modelTotal = await page.evaluate(() => window.__board.state.token.models.length);
  const projTotal = await page.evaluate(() => (window.__board.state.byProject || []).length);
  await page.evaluate(() => document.querySelectorAll('.hbar-toggle').forEach((t) => t.click()));
  await page.waitForTimeout(400); // 等 grid-rows 过渡
  const drawerOpen = await page.evaluate(() => ({
    modelOpen: !!document.querySelector('#model-bars .model-drawer.open'),
    modelRows: document.querySelectorAll('#model-bars .model-drawer .hbar-row').length,
    projOpen: !!document.querySelector('#project-bars .model-drawer.open'),
    projRows: document.querySelectorAll('#project-bars .model-drawer .hbar-row').length,
  }));
  check(drawerOpen.modelOpen && drawerOpen.modelRows === modelTotal - 6 && drawerOpen.modelRows > 0,
    `模型抽屉展开：${drawerOpen.modelRows} 行明细（模型总数 ${modelTotal}）`);
  check(projTotal <= 6 || (drawerOpen.projOpen && drawerOpen.projRows === projTotal - 6),
    `项目抽屉展开：${drawerOpen.projRows} 行明细（项目总数 ${projTotal}）`);
  await shot('tab2-light-drawer.png');
  await page.evaluate(() => window.__board.setTheme('dark'));
  await page.waitForTimeout(300);
  await shot('tab2-dark-drawer.png');
  await page.evaluate(() => document.querySelectorAll('.hbar-toggle').forEach((t) => t.click()));
  await page.waitForTimeout(400);
  const drawerClosed = await page.evaluate(() => !document.querySelector('.model-drawer.open'));
  check(drawerClosed, '抽屉收起恢复');

  // —— 里程碑面板：累计与峰值非占位，副标含日期 ——
  const ms = await page.evaluate(() => ({
    total: document.querySelector('#ms-total').textContent,
    totalSub: document.querySelector('#ms-total-sub').textContent,
    peak: document.querySelector('#ms-peak').textContent,
    peakSub: document.querySelector('#ms-peak-sub').textContent,
  }));
  check(/亿|万/.test(ms.total) && /\d{4}-\d{2}-\d{2} 起/.test(ms.totalSub),
    `里程碑累计（${ms.total}，${ms.totalSub}）`);
  check(/亿|万/.test(ms.peak) && /\d{4}-\d{2}-\d{2}/.test(ms.peakSub),
    `里程碑单日峰值（${ms.peak}，${ms.peakSub}）`);

  // —— 面板折叠：每日用量收起 → 热力图高度 0 + localStorage 持久化；展开恢复 ——
  await page.evaluate(() => document.querySelector('.panel-toggle[data-target="heatmap"]').click());
  await page.waitForTimeout(400); // 等 grid-rows 过渡
  const col1 = await page.evaluate(() => ({
    collapsed: document.querySelector('.panel[data-panel="heatmap"]').classList.contains('collapsed'),
    // 折叠裁的是 .panel-body（grid 行高 →0），子元素 #heatmap 自身高度不变
    bodyH: document.querySelector('.panel[data-panel="heatmap"] .panel-body').getBoundingClientRect().height,
    saved: JSON.parse(localStorage.getItem('aub:panel-collapsed') || '{}').heatmap === true,
  }));
  check(col1.collapsed && col1.bodyH === 0 && col1.saved,
    `每日用量面板折叠（body 高度 ${col1.bodyH}，持久化=${col1.saved}）`);
  await shot('tab2-dark-collapsed.png');
  await page.evaluate(() => document.querySelector('.panel-toggle[data-target="heatmap"]').click());
  await page.waitForTimeout(400);
  const col2 = await page.evaluate(() => ({
    collapsed: document.querySelector('.panel[data-panel="heatmap"]').classList.contains('collapsed'),
    bodyH: document.querySelector('.panel[data-panel="heatmap"] .panel-body').getBoundingClientRect().height,
    saved: 'heatmap' in JSON.parse(localStorage.getItem('aub:panel-collapsed') || '{}'),
  }));
  check(!col2.collapsed && col2.bodyH > 100 && !col2.saved,
    `每日用量面板展开恢复（body 高度 ${col2.bodyH}，持久化已清除=${!col2.saved}）`);

  // —— hover 浮标：柱状图（dark）+ 热力图（light）——
  // 里程碑面板把趋势图推到首屏以下，先把 canvas 滚进视口再算命中坐标
  const barPos = await page.evaluate(() => {
    const c = document.querySelector('#trend-canvas');
    c.scrollIntoView({ block: 'center' });
    const g = window.__board.state.chartGeom;
    const r = c.getBoundingClientRect();
    const b = g.bars[Math.floor(g.bars.length / 2)];
    return { x: r.left + b.x + b.w / 2, y: r.top + g.padT + g.plotH / 2 };
  });
  await page.mouse.move(barPos.x, barPos.y);
  await page.waitForTimeout(250); // 等 scrollIntoView 的异步 scroll 事件（会 hideTip）先落完
  await page.mouse.move(barPos.x + 1, barPos.y); // canvas 是 mousemove，挪 1px 即可重触发
  await page.waitForTimeout(150);
  const tip1 = await page.evaluate(() => {
    const t = document.querySelector('#aub-tooltip');
    return { vis: !t.hidden, text: t.innerText };
  });
  check(tip1.vis && /\d{4}-\d{2}-\d{2}/.test(tip1.text) && /亿|万/.test(tip1.text),
    `柱状图 hover 浮标（${tip1.text.split('\n')[0]}，含日期与数值）`);
  await shot('tab2-dark-hoverbar.png', { fullPage: false });

  await page.evaluate(() => window.__board.setTheme('light'));
  await page.waitForTimeout(200);
  const cellPos = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.hm-cell[data-tokens]')].filter((c) => +c.dataset.tokens > 0);
    const c = cells[cells.length - 1];
    c.scrollIntoView({ block: 'center' });
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(cellPos.x, cellPos.y);
  await page.waitForTimeout(250); // 等 scrollIntoView 的异步 scroll 事件（会 hideTip）先落完
  await page.mouse.move(cellPos.x, cellPos.y - 12); // 移出再移回，重新触发 mouseover
  await page.mouse.move(cellPos.x, cellPos.y);
  await page.waitForTimeout(150);
  const tip2 = await page.evaluate(() => {
    const t = document.querySelector('#aub-tooltip');
    return { vis: !t.hidden, text: t.innerText };
  });
  check(tip2.vis && /\d{4}-\d{2}-\d{2}/.test(tip2.text) && /亿|万/.test(tip2.text),
    `热力图 hover 浮标（${tip2.text.split('\n')[0]}，含日期与数值）`);
  await shot('tab2-light-hoverhm.png', { fullPage: false });

  // 热力图一年视图：54 列（52 周 + 2 未来列）、未来格样式类、空格 hover 显示无数据
  const hmInfo = await page.evaluate(() => ({
    cols: document.querySelectorAll('.hm-col').length,
    futureCells: document.querySelectorAll('.hm-cell.hm-future').length,
    emptyCellPos: (() => {
      const c = document.querySelector('.hm-cell[data-tokens="0"]');
      if (!c) return null;
      c.scrollIntoView({ block: 'center' });
      const r = c.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })(),
  }));
  check(hmInfo.cols === 54, `热力图 54 列（52 周 + 2 未来列），实际 ${hmInfo.cols}`);
  check(hmInfo.futureCells >= 14, `未来格 ${hmInfo.futureCells} 个（2 未来列 14 + 本周剩余天，≥14 即对）`);

  // 分档区分度：用户点名的三天（2.34亿/5.6亿/11.7亿量级）应落三个不同档
  const lvInfo = await page.evaluate(() => {
    const bgOf = (date) => {
      const c = document.querySelector(`.hm-cell[data-date="${date}"]`);
      return c ? getComputedStyle(c).backgroundColor : null;
    };
    return { d19: bgOf('2026-08-19'), d12: bgOf('2026-08-12'), d13: bgOf('2026-08-13') };
  });
  const distinct = new Set([lvInfo.d19, lvInfo.d12, lvInfo.d13].filter(Boolean));
  check(distinct.size === 3, `三天分落三档（08-19/08-12/08-13 颜色 ${distinct.size}/3 不同）`);
  if (hmInfo.emptyCellPos) {
    await page.mouse.move(hmInfo.emptyCellPos.x, hmInfo.emptyCellPos.y);
    await page.waitForTimeout(150);
    const tipEmpty = await page.evaluate(() => document.querySelector('#aub-tooltip').innerText);
    check(/无数据/.test(tipEmpty), `空格 hover 显示「无数据」（${tipEmpty.split('\n')[0]}）`);
  }
  await page.evaluate(() => window.__board.setTheme('dark'));

  // —— 一键分享卡：canvas 直出 PNG（亮色像素断言）+ 弹层打开/关闭 + 导出原图目检 ——
  const share = await page.evaluate(async () => {
    const c = await window.__board.drawShareCard();
    const x = c.getContext('2d');
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let bright = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 180 && d[i + 1] > 180 && d[i + 2] > 180) bright++;
    }
    return { w: c.width, h: c.height, bright, dataURL: c.toDataURL('image/png') };
  });
  check(share.bright > 2000, `分享卡已绘制（${share.w}×${share.h}，亮色像素 ${share.bright}）`);
  fs.writeFileSync(shotsDir + 'share-card.png', Buffer.from(share.dataURL.split(',')[1], 'base64'));
  console.log('✓ 分享卡原图 → shots/share-card.png');
  // 卡面跟随主题：浅色模式再出一张（淡薰衣草极光）
  const shareLight = await page.evaluate(async () => {
    window.__board.setTheme('light');
    const c = await window.__board.drawShareCard();
    const u = c.toDataURL('image/png');
    window.__board.setTheme('dark');
    return u;
  });
  fs.writeFileSync(shotsDir + 'share-card-light.png', Buffer.from(shareLight.split(',')[1], 'base64'));
  console.log('✓ 分享卡原图（浅色）→ shots/share-card-light.png');
  await page.evaluate(() => window.__board.openShare());
  await page.waitForTimeout(300);
  const shareUi = await page.evaluate(() => ({
    open: !document.querySelector('#share-overlay').hidden,
    btns: [...document.querySelectorAll('#share-overlay .share-btn')].map((b) => b.textContent),
  }));
  check(shareUi.open && shareUi.btns.includes('保存 PNG') && shareUi.btns.includes('复制图片'),
    `分享弹层打开（按钮：${shareUi.btns.join('/')}）`);
  await shot('tab2-dark-share.png', { fullPage: false });
  await page.evaluate(() => document.querySelector('#share-overlay .share-btn').click());
  await page.waitForTimeout(200);
  check(await page.evaluate(() => document.querySelector('#share-overlay').hidden), '分享弹层关闭');

  // 页面渲染真实数据：无 MOCK pill，DeepSeek 余额 ≠ mock 值
  const pageInfo = await page.evaluate(() => ({
    mockPill: !document.querySelector('#mock-pill').hidden,
    bodyText: document.body.innerText,
    mergeTag: [...document.querySelectorAll('#project-bars .hbar-tag')].map((t) => t.textContent),
  }));
  check(!pageInfo.mockPill, '页面无「MOCK 数据」pill（真实源生效）');
  check(!pageInfo.bodyText.includes('1,037.84'), '页面 DeepSeek 余额非 mock 值');
  check(pageInfo.mergeTag.some((t) => t.includes('已合并 2 个目录')),
    `项目面板显示归并标记（${pageInfo.mergeTag.join('、') || '无'}）`);

  // 安全断言：页面与 console 不出现密钥形态字符串（sk- 系 + JWT 的 eyJ 开头）
  const SK_RE = /sk-((or|ant)-)?[A-Za-z0-9]/;
  const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}/;
  const leakInBody = SK_RE.test(pageInfo.bodyText) || JWT_RE.test(pageInfo.bodyText);
  const leakInConsole = consoleTexts.some((t) => SK_RE.test(t) || JWT_RE.test(t));
  check(!leakInBody && !leakInConsole, '页面/console 无 sk-/eyJ 泄露');

  // canvas / 告警 / 控制台
  const painted = await page.evaluate(() => {
    window.__board.switchTab('token');
    const c = document.querySelector('#trend-canvas');
    const x = c.getContext('2d');
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let nonBg = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const isPanel = d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245;
      const isBg = Math.abs(d[i] - 245) < 4 && Math.abs(d[i + 1] - 246) < 4;
      if (!isPanel && !isBg) nonBg++;
    }
    return nonBg;
  });
  check(painted > 1000, `canvas 已绘制（light，非背景像素 ${painted}）`);

  const alertInfo = await page.evaluate(() => ({
    stateCount: window.__board.state.alerts.length,
    domCount: document.querySelectorAll('.alert-chip').length,
    texts: window.__board.state.alerts.map((a) => `${a.level}:${a.text}`),
  }));
  check(alertInfo.stateCount === alertInfo.domCount, `告警条数一致（${alertInfo.stateCount}）`);
  for (const t of alertInfo.texts) console.log(`  · ${t}`);

  check(errors.length === 0, errors.length === 0 ? '控制台无报错' : `控制台报错 ${errors.length} 条：${errors.join(' | ')}`);

  await browser.close();

  // —— stale 降级：独立实例（8180）构造「第二次起配额查询必失败」（三渠道同测）——
  const TEST_PORT = 8180;
  const testServer = spawn(process.execPath, ['server/server.mjs'], {
    cwd: moduleRoot, stdio: 'ignore',
    env: {
      ...process.env, PORT: String(TEST_PORT),
      AUB_TEST_KIMI_FAIL_AFTER: '2', AUB_TEST_CLAUDE_FAIL_AFTER: '2', AUB_TEST_CODEX_FAIL_AFTER: '2',
    },
  });
  try {
    for (let i = 0; i < 60 && !(await httpOk(TEST_PORT, '/api/health')); i++) await new Promise((r) => setTimeout(r, 500));
    // 注意 warm() 与首次请求的 inflight 合并会让计数少 1，打 3 发：首发 online、末发 stale
    const q1 = await apiJson(TEST_PORT, '/api/quota');
    await apiJson(TEST_PORT, '/api/quota');
    const q3 = await apiJson(TEST_PORT, '/api/quota');
    for (const id of ['kimi', 'claude', 'codex']) {
      const c1 = q1.channels.find((c) => c.id === id);
      const c3 = q3.channels.find((c) => c.id === id);
      check(c1?.status === 'online', `${id} 首次查询 online（source=${c1?.source || '—'}）`);
      check(c3?.status === 'stale' && (c3.note || '').includes('查询失败重试中'),
        `${id} 查询失败降级为 stale（note=${c3?.note || '无'}，而非 offline）`);
    }
  } finally {
    testServer.kill();
  }
} catch (e) {
  console.error('✗ probe 异常：', e.message);
  exitCode = 1;
} finally {
  if (ownServer) {
    ownServer.kill();
    console.log(`· 临时 server :${port} 已停`);
  }
}
process.exit(exitCode);
