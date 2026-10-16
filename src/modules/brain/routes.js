import { Router } from 'express';
import { z } from 'zod';
import { connectBrain, brainStatus, disconnectBrain } from './service.js';
import { audit } from '../../lib/audit.js';

export const brainRoutes = Router();
brainRoutes.post('/connect', async (req, res) => {
  const input = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(512) }).strict().parse(req.body);
  const result = await connectBrain(req.userId, input);
  await audit(req, 'brain.connect', { mode: result.mode });
  res.json(result);
});
brainRoutes.get('/status', async (req, res) => res.json(await brainStatus(req.userId)));
brainRoutes.delete('/disconnect', async (req, res) => { const result = await disconnectBrain(req.userId); await audit(req, 'brain.disconnect'); res.json(result); });
