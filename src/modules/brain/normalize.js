const metricKeys = ['sharpe', 'fitness', 'turnover', 'returns', 'drawdown', 'margin', 'longCount', 'shortCount'];
export function normalizeBrainResult(alphaPayload = {}, pnlPayload = {}) {
  const metrics = alphaPayload.metrics ?? alphaPayload;
  const result = {};
  for (const key of metricKeys) if (typeof metrics[key] === 'number' && Number.isFinite(metrics[key])) result[key] = metrics[key];
  return {
    ...result,
    ...(typeof alphaPayload.pnlTotal === 'number' && Number.isFinite(alphaPayload.pnlTotal) ? { pnlTotal: alphaPayload.pnlTotal } : {}),
    ...(typeof alphaPayload.pnlTotalPct === 'number' && Number.isFinite(alphaPayload.pnlTotalPct) ? { pnlTotalPct: alphaPayload.pnlTotalPct } : {}),
    yearly: Array.isArray(alphaPayload.yearly) ? alphaPayload.yearly : [],
    checks: Array.isArray(alphaPayload.checks) ? alphaPayload.checks : [],
    pnl: Array.isArray(pnlPayload.points) ? pnlPayload.points : (Array.isArray(pnlPayload) ? pnlPayload : []),
    source: alphaPayload.provider === 'local-mock' ? 'mock' : 'brain'
  };
}
