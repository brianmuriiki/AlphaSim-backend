import { Router } from 'express';
import { z } from 'zod';
import { Experiment } from '../../models/Experiment.js';
import { AlphaVersion } from '../../models/AlphaVersion.js';
import { Simulation } from '../../models/Simulation.js';
import { User } from '../../models/User.js';
import { parseExpression } from '../../lib/linter.js';
import { saveVersion } from '../alphas/service.js';
import { enqueueSnapshot } from '../simulations/service.js';
import { publishEvent } from '../../realtime/events.js';
import { AppError } from '../../lib/errors.js';
import { env } from '../../config/env.js';

export const experimentRoutes = Router();
const schema = z.object({ name: z.string().trim().min(1).max(120), baseVersionId: z.string(), parameterGrid: z.array(z.object({ path: z.string().max(80), values: z.array(z.union([z.number(), z.string().max(80)])).min(1).max(12) }).strict()).min(1).max(4) }).strict().superRefine((input, ctx) => {
  const paths = input.parameterGrid.map(({ path }) => path);
  if (new Set(paths).size !== paths.length) ctx.addIssue({ code: 'custom', path: ['parameterGrid'], message: 'Each parameter path may appear only once' });
});

function variantsFor(expression, settings, grid) {
  const combinations = grid.reduce((rows, item) => rows.flatMap((row) => item.values.map((value) => ({ ...row, [item.path]: value }))), [{}]);
  const experimentLimit = 12;
  if (combinations.length > experimentLimit) throw new AppError(422, 'EXPERIMENT_TOO_LARGE', `Experiment is limited to ${experimentLimit} variants`);
  return combinations.map((values) => {
    let code = expression; const nextSettings = structuredClone(settings ?? {});
    const literalTokens = [];
    try { for (const statement of parseExpression(expression)) collectNumbers(statement.expression, literalTokens); } catch (error) { throw new AppError(422, 'INVALID_EXPRESSION', error.message); }
    const literalEdits = [];
    for (const [path, value] of Object.entries(values)) {
      const literal = path.match(/^literal\.(\d+)$/);
      const setting = path.match(/^settings\.([A-Za-z][A-Za-z0-9.]*)$/);
      if (literal) {
        const token = literalTokens[Number(literal[1])];
        if (!token) throw new AppError(422, 'INVALID_PARAMETER_PATH', `Unknown numeric literal '${path}'`);
        literalEdits.push({ start: token.start, end: token.end, value: String(value) });
      } else if (setting && ['region', 'universe', 'delay', 'decay', 'neutralization', 'truncation', 'pasteurization', 'nanHandling', 'language'].includes(setting[1])) {
        nextSettings[setting[1]] = value;
      } else throw new AppError(422, 'INVALID_PARAMETER_PATH', `Unsupported parameter path '${path}'`);
    }
    for (const edit of literalEdits.sort((a, b) => b.start - a.start)) code = code.slice(0, edit.start) + edit.value + code.slice(edit.end);
    return { expression: code, settings: nextSettings, values };
  });
}
function collectNumbers(node, out) {
  if (node.type === 'number') out.push(node.token);
  if (node.type === 'call') node.args.forEach((child) => collectNumbers(child, out));
  if (node.type === 'binary') { collectNumbers(node.left, out); collectNumbers(node.right, out); }
  if (node.type === 'unary') collectNumbers(node.value, out);
}

experimentRoutes.post('/', async (req, res) => {
  const input = schema.parse(req.body);
  const base = await AlphaVersion.findOne({ _id: input.baseVersionId, userId: req.userId }).lean();
  if (!base) throw new AppError(404, 'NOT_FOUND', 'Base version was not found');
  const variants = variantsFor(base.expression, base.settings, input.parameterGrid);
  const user = await User.findOne({ _id: req.userId, 'brainConnection.status': 'connected' }).select('_id').lean();
  if (!user) throw new AppError(409, 'BRAIN_NOT_CONNECTED', 'Connect BRAIN before creating an experiment');
  const experiment = await Experiment.create({ userId: req.userId, name: input.name, baseVersionId: base._id, parameterGrid: input.parameterGrid, status: 'running', progress: { total: variants.length, done: 0, failed: 0 } });
  const ids = [];
  try {
    for (const variant of variants) {
      const version = await saveVersion(req.userId, base.alphaId, { ...variant, source: 'sweep', note: `Experiment ${experiment.id}: ${JSON.stringify(variant.values)}` });
      const sim = await enqueueSnapshot(req.userId, { alphaId: base.alphaId, versionId: version._id, experimentId: experiment._id, deferSlot: true });
      ids.push(sim._id);
    }
  } catch (error) {
    await Experiment.updateOne({ _id: experiment._id }, { $set: { status: 'failed', simulationIds: ids, 'progress.total': ids.length } });
    throw error;
  }
  experiment.simulationIds = ids;
  await experiment.save();
  await publishEvent(req.userId, 'experiment.progress', { id: experiment.id, done: 0, total: variants.length, failed: 0 });
  res.status(202).json({ data: experiment });
});

experimentRoutes.get('/:id', async (req, res) => {
  const experiment = await Experiment.findOne({ _id: req.params.id, userId: req.userId }).lean();
  if (!experiment) throw new AppError(404, 'NOT_FOUND', 'Experiment was not found');
  const simulations = await Simulation.find({ _id: { $in: experiment.simulationIds }, userId: req.userId }).sort({ runNumber: 1 }).lean();
  res.json({ data: { ...experiment, simulations } });
});
