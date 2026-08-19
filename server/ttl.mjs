// ttl.mjs — 极简 TTL 缓存 + stale-while-revalidate。
// 过期不阻塞：有旧数据先返旧数据，后台异步刷新；首次无缓存才等待。
export function swr(ttlMs, fn) {
  let cache = null;
  let inflight = null;
  const run = () => {
    if (!inflight) {
      inflight = Promise.resolve()
        .then(fn)
        .then((data) => { cache = { ts: Date.now(), data }; return data; })
        .finally(() => { inflight = null; });
    }
    return inflight;
  };
  return {
    async get() {
      if (cache && Date.now() - cache.ts < ttlMs) return cache.data;
      if (cache) { run().catch(() => {}); return cache.data; } // stale + 后台刷新
      return run(); // 首次：只能等
    },
    warm() { run().catch(() => {}); }, // 启动预热，不等
    lastOk() { return cache ? cache.ts : 0; },
  };
}

// staleGate：TTL 缓存 + 失败降级。成功刷新 lastGood；失败时有 ≤staleMax 的旧快照
// 则返回 {stale:true, ageMs}（调用方映射为渠道 stale 态），否则抛错（→ offline）。
export function staleGate(ttlMs, staleMaxMs, fetchFn) {
  let lastGood = null;
  let inflight = null;
  return async function get({ bypassTtl = false } = {}) {
    if (!bypassTtl && lastGood && Date.now() - lastGood.ts < ttlMs) {
      return { data: lastGood.data, stale: false };
    }
    if (!inflight) {
      inflight = Promise.resolve().then(fetchFn)
        .then((data) => { lastGood = { data, ts: Date.now() }; return data; })
        .finally(() => { inflight = null; });
    }
    try {
      const data = await inflight;
      return { data, stale: false };
    } catch (e) {
      if (lastGood && Date.now() - lastGood.ts < staleMaxMs) {
        return { data: lastGood.data, stale: true, ageMs: Date.now() - lastGood.ts };
      }
      throw e;
    }
  };
}
