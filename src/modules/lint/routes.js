import { Router } from 'express';
import { z } from 'zod';
import { lintExpression } from '../../lib/linter.js';

export const lintRoutes = Router();
lintRoutes.post('/', async (req, res) => {
  const input = z.object({ expression: z.string().max(50000), settings: z.object({ region: z.string().optional(), universe: z.string().optional(), delay: z.number().optional() }).optional() }).strict().parse(req.body);
  res.json(await lintExpression(input.expression, { ...input.settings, ownerUserId: req.userId }));
});
