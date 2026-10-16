import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { Folder } from '../../models/Folder.js';
import { Alpha } from '../../models/Alpha.js';
import { AppError } from '../../lib/errors.js';

export const folderRoutes = Router();
const createSchema = z.object({ name: z.string().trim().min(1).max(80), parentId: z.string().nullable().optional() }).strict();
const patchSchema = z.object({ name: z.string().trim().min(1).max(80), parentId: z.string().nullable().optional() }).strict();
function checkId(id) { if (!mongoose.isValidObjectId(id)) throw new AppError(400, 'INVALID_ID', 'Folder id is invalid'); }
async function checkParent(userId, parentId, folderId = null) {
  if (!parentId) return;
  checkId(parentId);
  if (folderId && String(folderId) === parentId) throw new AppError(400, 'FOLDER_CYCLE', 'A folder cannot be its own parent');
  let current = await Folder.findOne({ _id: parentId, userId }).select('parentId').lean();
  if (!current) throw new AppError(404, 'NOT_FOUND', 'Parent folder was not found');
  while (current?.parentId) {
    if (folderId && String(current.parentId) === String(folderId)) throw new AppError(400, 'FOLDER_CYCLE', 'A folder cannot be moved inside its descendant');
    current = await Folder.findOne({ _id: current.parentId, userId }).select('parentId').lean();
  }
}

folderRoutes.get('/', async (req, res) => {
  const folders = await Folder.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(req.userId) } },
    { $lookup: { from: 'alphas', let: { folder: '$_id' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$folderId', '$$folder'] }, { $eq: ['$userId', new mongoose.Types.ObjectId(req.userId)] }, { $eq: ['$deletedAt', null] }] } } }, { $count: 'count' }], as: 'alphaCounts' } },
    { $addFields: { alphaCount: { $ifNull: [{ $first: '$alphaCounts.count' }, 0] } } },
    { $project: { alphaCounts: 0 } }, { $sort: { name: 1 } }
  ]);
  res.json({ data: folders });
});

folderRoutes.post('/', async (req, res) => {
  const input = createSchema.parse(req.body);
  await checkParent(req.userId, input.parentId);
  const folder = await Folder.create({ userId: req.userId, ...input });
  res.status(201).json({ data: folder });
});

folderRoutes.patch('/:id', async (req, res) => {
  checkId(req.params.id);
  const input = patchSchema.parse(req.body);
  await checkParent(req.userId, input.parentId, req.params.id);
  const folder = await Folder.findOneAndUpdate({ _id: req.params.id, userId: req.userId }, { $set: input }, { new: true, runValidators: true });
  if (!folder) throw new AppError(404, 'NOT_FOUND', 'Folder was not found');
  res.json({ data: folder });
});

folderRoutes.delete('/:id', async (req, res) => {
  checkId(req.params.id);
  const folder = await Folder.findOne({ _id: req.params.id, userId: req.userId });
  if (!folder) throw new AppError(404, 'NOT_FOUND', 'Folder was not found');
  if (await Folder.exists({ userId: req.userId, parentId: folder._id }) || await Alpha.exists({ userId: req.userId, folderId: folder._id, deletedAt: null })) {
    throw new AppError(409, 'FOLDER_NOT_EMPTY', 'Move or delete the folder contents before deleting this folder');
  }
  await folder.deleteOne();
  res.status(204).end();
});
