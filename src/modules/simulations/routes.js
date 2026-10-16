import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { Simulation } from '../../models/Simulation.js';
import { rawResultStream } from '../../lib/gridfs.js';
import { audit } from '../../lib/audit.js';
import { createSimulation, listSimulations, getSimulation, compareSimulations, retrySimulation, cancelSimulation } from './service.js';

export const simulationRoutes = Router();
const settingsSchema = z.object({ region: z.string().max(40).default('USA'), universe: z.string().max(80).default('TOP3000'), delay: z.number().int().min(0).max(2).default(1), decay: z.number().min(0).max(100).default(0), neutralization: z.string().max(40).default('SUBINDUSTRY'), truncation: z.number().min(0).max(1).default(0.08), pasteurization: z.string().max(40).default('ON'), nanHandling: z.string().max(40).default('OFF'), language: z.string().max(40).default('FASTEXPR') }).strict();
const createSchema = z.object({ alphaId: z.string(), versionId: z.string().optional(), expression: z.string().max(50000).optional(), settings: settingsSchema.default({}), source: z.enum(['manual', 'ai']).default('manual') }).strict().superRefine((value, ctx) => {
  if (!value.versionId && !value.expression) ctx.addIssue({ code: 'custom', path: ['expression'], message: 'Expression is required when versionId is omitted' });
});

simulationRoutes.post('/', async (req, res) => {
  const input = createSchema.parse(req.body);
  const sim = await createSimulation(req.userId, input);
  await audit(req, 'simulation.create', { simulationId: sim.id, alphaId: sim.alphaId, runNumber: sim.runNumber });
  res.status(202).json({ id: sim.id, runNumber: sim.runNumber, status: sim.status });
});
simulationRoutes.get('/', async (req, res) => {
  const query = z.object({ limit: z.coerce.number().int().positive().max(100).optional(), cursor: z.string().optional(), alphaId: z.string().optional(), status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']).optional() }).parse(req.query);
  res.json(await listSimulations(req.userId, query));
});
simulationRoutes.get('/compare', async (req, res) => {
  const ids = z.string().transform((value) => value.split(',')).parse(req.query.ids);
  res.json({ data: await compareSimulations(req.userId, ids) });
});
simulationRoutes.get('/:id/raw', async (req, res, next) => {
  const sim = await Simulation.findOne({ _id: req.params.id, userId: req.userId }).select('+rawResultRef').lean();
  if (!sim) throw new AppError(404, 'NOT_FOUND', 'Simulation was not found');
  if (!sim.rawResultRef) throw new AppError(404, 'RAW_RESULT_NOT_FOUND', 'Raw result was not found');
  const stream = rawResultStream(sim.rawResultRef);
  stream.on('error', next);
  res.type('application/json');
  stream.pipe(res);
});
simulationRoutes.get('/:id', async (req, res) => res.json(await getSimulation(req.userId, req.params.id)));
simulationRoutes.post('/:id/retry', async (req, res) => {
  const sim = await retrySimulation(req.userId, req.params.id);
  res.status(202).json({ id: sim.id, runNumber: sim.runNumber, status: sim.status });
});
simulationRoutes.delete('/:id', async (req, res) => { const sim = await cancelSimulation(req.userId, req.params.id); res.json({ id: sim.id, status: sim.status }); });
