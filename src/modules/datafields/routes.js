import { Router } from 'express';
import { z } from 'zod';
import { Datafield } from '../../models/Datafield.js';
import { Operator } from '../../models/Operator.js';

export const datafieldRoutes = Router();
export const operatorRoutes = Router();

datafieldRoutes.get('/', async (req, res) => {
  const query = z.object({ q: z.string().max(100).optional(), region: z.string().max(40).optional(), universe: z.string().max(80).optional(), delay: z.coerce.number().int().optional(), dataset: z.string().max(100).optional(), limit: z.coerce.number().int().positive().max(100).default(50), cursor: z.string().optional() }).parse(req.query);
  const filter = { $or: [{ ownerUserId: null }, { ownerUserId: req.userId }] };
  if (query.region) filter.region = query.region;
  if (query.universe) filter.universe = query.universe;
  if (query.delay !== undefined) filter.delay = query.delay;
  if (query.dataset) filter.datasetId = query.dataset;
  if (query.q) filter.$text = { $search: query.q };
  if (query.cursor) filter._id = { $gt: query.cursor };
  const [items, total] = await Promise.all([Datafield.find(filter).sort({ _id: 1 }).limit(query.limit + 1).lean(), Datafield.countDocuments(filter)]);
  const hasMore = items.length > query.limit;
  if (hasMore) items.pop();
  res.json({ items, total, nextCursor: hasMore ? String(items.at(-1)._id) : null });
});
operatorRoutes.get('/', async (req, res) => {
  const query = z.object({ q: z.string().max(100).optional(), category: z.string().max(60).optional(), limit: z.coerce.number().int().positive().max(200).default(100) }).parse(req.query);
  const filter = {};
  if (query.category) filter.category = query.category;
  if (query.q) filter.$text = { $search: query.q };
  const items = await Operator.find(filter).sort({ category: 1, name: 1 }).limit(query.limit).lean();
  const count = await Operator.countDocuments(filter);
  res.json({ items, count });
});
