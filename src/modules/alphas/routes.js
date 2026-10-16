import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Alpha } from '../../models/Alpha.js';
import { AlphaVersion } from '../../models/AlphaVersion.js';
import { AppError } from '../../lib/errors.js';
import { saveVersion, restoreVersion, versionHash } from './service.js';
import { Folder } from '../../models/Folder.js';

export const alphaRoutes = Router();
const settingsSchema = z.object({ region: z.string().max(40).optional(), universe: z.string().max(80).optional(), delay: z.number().int().min(0).max(2).optional(), decay: z.number().min(0).max(100).optional(), neutralization: z.string().max(40).optional(), truncation: z.number().min(0).max(1).optional(), pasteurization: z.string().max(40).optional(), nanHandling: z.string().max(40).optional(), language: z.string().max(40).optional() }).strict();
const createSchema = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(2000).optional(), expression: z.string().max(50000).default(''), settings: settingsSchema.optional(), folderId: z.string().nullable().optional(), tags: z.array(z.string().trim().min(1).max(40)).max(30).optional() }).strict();
const patchSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().max(2000).optional(), folderId: z.string().nullable().optional(), tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(), status: z.enum(['draft', 'testing', 'candidate', 'submitted', 'archived']).optional() }).strict();

function checkId(id) { if (!mongoose.isValidObjectId(id)) throw new AppError(400, 'INVALID_ID', 'Alpha id is invalid'); }
function validFolderId(id) { if (id && !mongoose.isValidObjectId(id)) throw new AppError(400, 'INVALID_ID', 'Folder id is invalid'); }
async function assertOwnedFolder(userId, folderId) { if (folderId && !await Folder.exists({ _id: folderId, userId })) throw new AppError(404, 'NOT_FOUND', 'Folder was not found'); }

alphaRoutes.get('/', async (req, res) => {
  const query = z.object({ limit: z.coerce.number().int().positive().max(100).default(50), page: z.coerce.number().int().positive().optional(), cursor: z.string().optional(), status: z.enum(['draft', 'testing', 'candidate', 'submitted', 'archived']).optional(), folderId: z.string().optional(), q: z.string().max(100).optional() }).parse(req.query);
  const limit = query.limit;
  const filter = { userId: req.userId, deletedAt: null };
  if (query.status) filter.status = query.status;
  if (query.folderId) {
    if (query.folderId !== 'root') validFolderId(query.folderId);
    filter.folderId = query.folderId === 'root' ? null : query.folderId;
  }
  if (query.cursor) { checkId(query.cursor); filter._id = { $lt: query.cursor }; }
  if (query.q?.trim()) {
    const escaped = query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [{ name: { $regex: escaped, $options: 'i' } }, { description: { $regex: escaped, $options: 'i' } }, { tags: { $regex: escaped, $options: 'i' } }];
  }
  const skip = query.cursor ? 0 : ((query.page ?? 1) - 1) * limit;
  const [items, total, folderCounts] = await Promise.all([
    Alpha.find(filter).sort({ _id: -1 }).skip(skip).limit(limit + 1).lean(),
    Alpha.countDocuments(filter),
    Alpha.aggregate([{ $match: { userId: new mongoose.Types.ObjectId(req.userId), deletedAt: null, folderId: { $ne: null } } }, { $group: { _id: '$folderId', count: { $sum: 1 } } }])
  ]);
  const hasMore = items.length > limit;
  if (hasMore) items.pop();
  const nextCursor = hasMore ? String(items.at(-1)._id) : null;
  res.json({ data: items, items, nextCursor, meta: { page: query.page ?? null, limit, total, folderCounts } });
});

alphaRoutes.post('/', async (req, res) => {
  const input = createSchema.parse(req.body);
  validFolderId(input.folderId);
  await assertOwnedFolder(req.userId, input.folderId);
  const alpha = await Alpha.create({ userId: req.userId, name: input.name, description: input.description, folderId: input.folderId, tags: input.tags, versionCounter: 1 });
  const version = await AlphaVersion.create({ alphaId: alpha.id, userId: req.userId, versionNumber: 1, expression: input.expression, settings: input.settings ?? {}, contentHash: versionHash(input.expression, input.settings), source: 'manual' });
  alpha.currentVersionId = version.id;
  await alpha.save();
  res.status(201).json({ data: { ...alpha.toObject(), currentVersion: version } });
});

alphaRoutes.get('/:id', async (req, res) => {
  checkId(req.params.id);
  const alpha = await Alpha.findOne({ _id: req.params.id, userId: req.userId, deletedAt: null }).lean();
  if (!alpha) throw new AppError(404, 'ALPHA_NOT_FOUND', 'Alpha was not found');
  const currentVersion = alpha.currentVersionId ? await AlphaVersion.findOne({ _id: alpha.currentVersionId, userId: req.userId }).lean() : null;
  res.json({ data: { ...alpha, currentVersion } });
});

alphaRoutes.patch('/:id', async (req, res) => {
  checkId(req.params.id);
  const input = patchSchema.parse(req.body);
  validFolderId(input.folderId);
  await assertOwnedFolder(req.userId, input.folderId);
  const alpha = await Alpha.findOneAndUpdate({ _id: req.params.id, userId: req.userId, deletedAt: null }, { $set: input }, { new: true, runValidators: true });
  if (!alpha) throw new AppError(404, 'ALPHA_NOT_FOUND', 'Alpha was not found');
  res.json({ data: alpha });
});

alphaRoutes.post('/:id/versions', async (req, res) => {
  checkId(req.params.id);
  const input = z.object({ expression: z.string().min(1).max(50000), settings: settingsSchema.optional(), source: z.enum(['manual', 'ai', 'sweep']).default('manual'), note: z.string().max(1000).optional() }).strict().parse(req.body);
  const alpha = await Alpha.findOne({ _id: req.params.id, userId: req.userId, deletedAt: null });
  if (!alpha) throw new AppError(404, 'ALPHA_NOT_FOUND', 'Alpha was not found');
  const version = await saveVersion(req.userId, alpha.id, input);
  res.status(201).json({ data: version });
});

alphaRoutes.post('/:id/versions/:versionNumber/restore', async (req, res) => {
  checkId(req.params.id);
  const versionNumber = Number(req.params.versionNumber);
  if (!Number.isInteger(versionNumber) || versionNumber < 1) throw new AppError(400, 'INVALID_VERSION', 'Version number is invalid');
  const version = await restoreVersion(req.userId, req.params.id, versionNumber);
  res.status(201).json({ data: version });
});

alphaRoutes.get('/:id/versions', async (req, res) => {
  checkId(req.params.id);
  const alpha = await Alpha.findOne({ _id: req.params.id, userId: req.userId, deletedAt: null }).select('_id').lean();
  if (!alpha) throw new AppError(404, 'ALPHA_NOT_FOUND', 'Alpha was not found');
  const versions = await AlphaVersion.find({ alphaId: alpha._id, userId: req.userId }).sort({ versionNumber: -1 }).lean();
  res.json({ data: versions });
});

alphaRoutes.put('/:id/draft', async (req, res) => {
  checkId(req.params.id);
  const input = z.object({ expression: z.string().max(50000), settings: settingsSchema.optional() }).strict().parse(req.body);
  const alpha = await Alpha.findOneAndUpdate(
    { _id: req.params.id, userId: req.userId, deletedAt: null },
    { $set: { draft: input } },
    { new: true, runValidators: true }
  ).select('_id draft updatedAt');
  if (!alpha) throw new AppError(404, 'ALPHA_NOT_FOUND', 'Alpha was not found');
  res.json({ data: alpha });
});

alphaRoutes.delete('/:id', async (req, res) => {
  checkId(req.params.id);
  const alpha = await Alpha.findOneAndUpdate({ _id: req.params.id, userId: req.userId, deletedAt: null }, { $set: { deletedAt: new Date() } }, { new: true });
  if (!alpha) throw new AppError(404, 'ALPHA_NOT_FOUND', 'Alpha was not found');
  res.status(204).end();
});
