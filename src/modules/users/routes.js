import { Router } from 'express';
import { z } from 'zod';
import { User } from '../../models/User.js';
import { Alpha } from '../../models/Alpha.js';
import { AlphaVersion } from '../../models/AlphaVersion.js';
import { Simulation } from '../../models/Simulation.js';
import { Folder } from '../../models/Folder.js';
import { Experiment } from '../../models/Experiment.js';
import { AIInteraction } from '../../models/AIInteraction.js';
import { AIConversation } from '../../models/AIConversation.js';
import { AuditLog } from '../../models/AuditLog.js';
import { Datafield } from '../../models/Datafield.js';
import { RefreshToken } from '../../models/RefreshToken.js';
import { simulationQueue } from '../../queue/index.js';
import { AppError } from '../../lib/errors.js';
import { deleteUserRawResults } from '../../lib/gridfs.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../config/env.js';
import { encrypt } from '../../lib/crypto.js';

export const userRoutes = Router();
userRoutes.get('/me/ai-key', async (req, res) => {
  const user = await User.findById(req.userId).select('+encryptedAiApiKey').lean();
  if (!user) throw new AppError(404, 'NOT_FOUND', 'User was not found');
  res.json({ configured: Boolean(user.encryptedAiApiKey || env.OPENROUTER_API_KEY), source: user.encryptedAiApiKey ? 'account' : env.OPENROUTER_API_KEY ? 'server' : 'none' });
});
userRoutes.put('/me/ai-key', async (req, res) => {
  const { apiKey } = z.object({ apiKey: z.string().trim().min(16).max(300) }).strict().parse(req.body);
  await User.updateOne({ _id: req.userId }, { $set: { encryptedAiApiKey: encrypt(apiKey) } });
  res.json({ configured: true, source: 'account' });
});
userRoutes.delete('/me/ai-key', async (req, res) => {
  await User.updateOne({ _id: req.userId }, { $unset: { encryptedAiApiKey: 1 } });
  res.status(204).end();
});
userRoutes.get('/me', async (req, res) => {
  const user = await User.findById(req.userId).select('email displayName preferences brainConnection.status brainConnection.sessionExpiresAt brainConnection.lastVerifiedAt brainConnection.mode aiUsage createdAt').lean();
  if (!user) throw new AppError(404, 'NOT_FOUND', 'User was not found');
  res.json({ data: { ...user, id: user._id, limits: { maxActiveRuns: env.MAX_SIMS_PER_USER } } });
});
userRoutes.patch('/me', async (req, res) => {
  const input = z.object({ displayName: z.string().trim().min(1).max(80).optional(), preferences: z.object({ theme: z.enum(['dark', 'light']).optional(), defaultSettingsPreset: z.string().max(80).optional(), editorFontSize: z.number().int().min(10).max(32).optional() }).strict().optional() }).strict().parse(req.body);
  const set = {};
  if (input.displayName !== undefined) set.displayName = input.displayName;
  if (input.preferences) for (const [key, value] of Object.entries(input.preferences)) set[`preferences.${key}`] = value;
  const user = await User.findByIdAndUpdate(req.userId, { $set: set }, { new: true, runValidators: true }).select('email displayName preferences');
  if (!user) throw new AppError(404, 'NOT_FOUND', 'User was not found');
  res.json({ data: user });
});
userRoutes.delete('/me', async (req, res) => {
  await audit(req, 'user.delete');
  const sims = await Simulation.find({ userId: req.userId }).select('_id').lean();
  await Simulation.updateMany({ userId: req.userId, status: { $in: ['queued', 'running'] } }, { $set: { status: 'cancelled', 'timing.finishedAt': new Date() } });
  for (const sim of sims) {
    const job = await simulationQueue.getJob(String(sim._id));
    if (job && ['waiting', 'delayed', 'paused'].includes(await job.getState())) await job.remove();
  }
  await deleteUserRawResults(req.userId);
  await Promise.all([
    Alpha.deleteMany({ userId: req.userId }), AlphaVersion.deleteMany({ userId: req.userId }), Simulation.deleteMany({ userId: req.userId }),
    Folder.deleteMany({ userId: req.userId }), Experiment.deleteMany({ userId: req.userId }), AIInteraction.deleteMany({ userId: req.userId }), AIConversation.deleteMany({ userId: req.userId }),
    AuditLog.deleteMany({ userId: req.userId }), RefreshToken.deleteMany({ userId: req.userId }),
    Datafield.deleteMany({ ownerUserId: req.userId }),
    User.deleteOne({ _id: req.userId })
  ]);
  res.status(204).end();
});
