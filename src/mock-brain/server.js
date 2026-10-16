import express from 'express';
import crypto from 'node:crypto';

const app = express();
const port = Number(process.env.MOCK_BRAIN_PORT ?? 4011);
const jobs = new Map();
const sessions = new Set();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.get('/healthz', (_req, res) => res.json({ status: 'ok', provider: 'local-mock' }));
app.post('/authentication', (_req, res) => {
  const token = crypto.randomUUID(); sessions.add(token);
  res.setHeader('Set-Cookie', `mock-session=${token}; HttpOnly; Path=/`);
  res.status(201).json({ status: 'connected', provider: 'local-mock' });
});
app.use((req, res, next) => {
  const token = req.get('cookie')?.match(/(?:^|;\s*)mock-session=([^;]+)/)?.[1];
  if (!token || !sessions.has(token)) return res.status(401).json({ error: 'mock session expired' });
  next();
});
app.post('/simulations', (req, res) => {
  if (typeof req.body.expression !== 'string' || !req.body.expression.trim()) return res.status(400).json({ error: 'expression required' });
  const id = crypto.randomUUID(); jobs.set(id, { polls: 0, expression: req.body.expression, settings: req.body.settings });
  res.location(`/simulations/${id}`).status(201).json({ id, provider: 'local-mock' });
});
app.get('/simulations/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'simulation not found' });
  if (job.polls++ < 2) { res.setHeader('Retry-After', '0.1'); return res.status(200).json({ status: 'running', provider: 'local-mock' }); }
  const alpha = `mock-alpha-${req.params.id}`;
  jobs.set(req.params.id, { ...job, alpha });
  return res.json({ status: 'complete', alpha, provider: 'local-mock' });
});
app.get('/alphas/:id', (req, res) => res.json({ id: req.params.id, provider: 'local-mock', metrics: { sharpe: 1.1, fitness: 0.8, turnover: 0.18, returns: 0.09, drawdown: 0.04, margin: 0.03 }, yearly: [], checks: [] }));
app.get('/alphas/:id/recordsets/pnl', (_req, res) => res.json({ provider: 'local-mock', points: [] }));
app.get('/catalog/datafields', (_req, res) => res.json({ items: [
  { region: 'USA', universe: 'TOP3000', delay: 1, datasetId: 'mock-price', name: 'close', description: 'Mock closing price field', type: 'MATRIX' },
  { region: 'USA', universe: 'TOP3000', delay: 1, datasetId: 'mock-price', name: 'open', description: 'Mock opening price field', type: 'MATRIX' },
  { region: 'USA', universe: 'TOP3000', delay: 1, datasetId: 'mock-price', name: 'volume', description: 'Mock traded volume field', type: 'MATRIX' },
  { region: 'USA', universe: 'TOP3000', delay: 1, datasetId: 'mock-fundamental', name: 'returns', description: 'Mock daily returns field', type: 'MATRIX' },
  { region: 'USA', universe: 'TOP3000', delay: 1, datasetId: 'mock-fundamental', name: 'cap', description: 'Mock market capitalization field', type: 'MATRIX' }
]}));
app.get('/catalog/operators', (_req, res) => res.json({ items: [
  { name: 'ts_delta', category: 'Time Series', signature: 'ts_delta(x, window)', minArgs: 2, maxArgs: 2, description: 'Difference between a value and its value at the start of a lookback window.' },
  { name: 'ts_rank', category: 'Time Series', signature: 'ts_rank(x, window)', minArgs: 2, maxArgs: 2, description: 'Rank a value within its trailing time series window.' },
  { name: 'group_neutralize', category: 'Group', signature: 'group_neutralize(x, group)', minArgs: 2, maxArgs: 2, description: 'Neutralize values within a group.' }
]}));

app.listen(port);
