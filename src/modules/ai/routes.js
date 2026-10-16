import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { streamChat, improve, explain, fix, generate } from './service.js';
import { AIInteraction } from '../../models/AIInteraction.js';
import { AIConversation } from '../../models/AIConversation.js';
import { Alpha } from '../../models/Alpha.js';
import { AppError } from '../../lib/errors.js';
import { RedisStore } from 'rate-limit-redis';
import { redis } from '../../lib/redis.js';

export const aiRoutes = Router();
const aiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, keyGenerator: (req) => req.userId, standardHeaders: true, legacyHeaders: false, store: new RedisStore({ prefix: 'alphasim:rl:ai:', sendCommand: (...args) => redis.call(...args) }), handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Forge AI request limit reached' } }) });
const contextFields = { alphaId: z.string().optional(), simulationId: z.string().optional(), expression: z.string().max(50000).optional(), settings: z.record(z.unknown()).optional() };

const conversationMessage = z.object({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(16000) }).strict();
aiRoutes.get('/conversations', async (req, res) => {
  const alphaId = z.string().optional().parse(req.query.alphaId);
  if (alphaId && !/^[a-f\d]{24}$/i.test(alphaId)) throw new AppError(400, 'VALIDATION_ERROR', 'alphaId is invalid');
  const filter = { userId: req.userId, ...(alphaId ? { alphaId } : {}) };
  const items = await AIConversation.find(filter).sort({ updatedAt: -1 }).limit(50).lean();
  res.json({ items });
});
aiRoutes.post('/conversations', async (req, res) => {
  const input = z.object({ alphaId: z.string(), title: z.string().trim().min(1).max(120), messages: z.array(conversationMessage).max(60).default([]) }).strict().parse(req.body);
  if (!/^[a-f\d]{24}$/i.test(input.alphaId) || !await Alpha.exists({ _id: input.alphaId, userId: req.userId, deletedAt: null })) throw new AppError(404, 'NOT_FOUND', 'Alpha was not found');
  const record = await AIConversation.create({ userId: req.userId, ...input });
  res.status(201).json({ data: record });
});
aiRoutes.patch('/conversations/:id', async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) throw new AppError(404, 'NOT_FOUND', 'AI conversation was not found');
  const input = z.object({ title: z.string().trim().min(1).max(120).optional(), messages: z.array(conversationMessage).max(60).optional() }).strict().refine((value) => Object.keys(value).length > 0).parse(req.body);
  const record = await AIConversation.findOneAndUpdate({ _id: req.params.id, userId: req.userId }, { $set: input }, { new: true, runValidators: true });
  if (!record) throw new AppError(404, 'NOT_FOUND', 'AI conversation was not found');
  res.json({ data: record });
});
aiRoutes.delete('/conversations/:id', async (req, res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) throw new AppError(404, 'NOT_FOUND', 'AI conversation was not found');
  const record = await AIConversation.findOneAndDelete({ _id: req.params.id, userId: req.userId });
  if (!record) throw new AppError(404, 'NOT_FOUND', 'AI conversation was not found');
  res.status(204).end();
});

aiRoutes.post('/chat', aiLimiter, async (req, res) => {
  const input = z.object({ message: z.string().trim().min(1).max(8000), ...contextFields, includeExpression: z.boolean().default(true), history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) })).max(20).default([]), datafieldNames: z.array(z.string().max(120)).max(20).default([]), attachments: z.array(z.object({ name: z.string().max(120), content: z.string().max(20000) }).strict()).max(3).default([]) }).strict().parse(req.body);
  await streamChat(req.userId, input, res);
});
aiRoutes.post('/improve', aiLimiter, async (req, res) => {
  const input = z.object({ ...contextFields, alphaId: z.string(), simulationId: z.string().optional() }).strict().parse(req.body);
  res.json(await improve(req.userId, input));
});
aiRoutes.post('/explain', aiLimiter, async (req, res) => {
  const input = z.object({ ...contextFields, alphaId: z.string().optional(), message: z.string().max(3000).optional() }).strict().parse(req.body);
  res.json(await explain(req.userId, input));
});
aiRoutes.post('/fix', aiLimiter, async (req, res) => {
  const input = z.object({ ...contextFields, alphaId: z.string().optional(), message: z.string().max(5000).optional(), errors: z.array(z.unknown()).optional() }).strict().parse(req.body);
  res.json(await fix(req.userId, { ...input, message: `${input.message ?? ''}\nValidation errors: ${JSON.stringify(input.errors ?? [])}` }));
});
aiRoutes.post('/generate', aiLimiter, async (req, res) => {
  const input = z.object({ ...contextFields, alphaId: z.string().optional(), message: z.string().trim().min(1).max(4000) }).strict().parse(req.body);
  res.json(await generate(req.userId, input));
});
aiRoutes.patch('/interactions/:id/outcome', async (req, res) => {
  const { accepted } = z.object({ accepted: z.boolean() }).strict().parse(req.body);
  const record = await AIInteraction.findOneAndUpdate({ _id: req.params.id, userId: req.userId }, { $set: { accepted, outcome: accepted ? 'accepted' : 'rejected' } }, { new: true }).select('_id accepted outcome');
  if (!record) throw new AppError(404, 'NOT_FOUND', 'AI interaction was not found');
  res.json({ data: record });
});
