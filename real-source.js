// real-source.js — HttpSource：实现与 MockSource 相同的接口，数据来自本地 server 的 /api/*。
// server 聚合四个渠道的真实数据（本地日志 + 官方 API），前端渲染层不感知差异。
export function createHttpSource(base = '/api') {
  async function get(path) {
    const res = await fetch(base + path, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  return {
    name: 'http',
    fetchQuota: () => get('/quota'),
    fetchTokenSeries: ({ days = 30, endOffset = 0, metric = 'total' } = {}) =>
      get(`/token-series?days=${days}&endOffset=${endOffset}&metric=${metric}`),
    fetchByProject: ({ days = 30, endOffset = 0, metric = 'total' } = {}) =>
      get(`/by-project?days=${days}&endOffset=${endOffset}&metric=${metric}`),
    fetchCostSummary: ({ days = 30 } = {}) => get(`/cost-summary?days=${days}`),
    fetchApiStatus: () => get('/status'),
  };
}
