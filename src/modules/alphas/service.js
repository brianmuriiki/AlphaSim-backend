import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Alpha } from '../../models/Alpha.js';
import { AlphaVersion } from '../../models/AlphaVersion.js';
import { AppError } from '../../lib/errors.js';

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
export function versionHash(expression, settings = {}) {
  const normalizedExpression = expression.replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(`${normalizedExpression}\n${stable(settings)}`).digest('hex');
}

export async function saveVersion(userId, alphaId, { expression, settings = {}, source = 'manual', note = '' }) {
  const alpha = await Alpha.findOne({ _id: alphaId, userId, deletedAt: null });
  if (!alpha) throw new AppError(404, 'NOT_FOUND', 'Alpha was not found');
  const hash = versionHash(expression, settings);
  const current = alpha.currentVersionId ? await AlphaVersion.findOne({ _id: alpha.currentVersionId, userId }).lean() : null;
  if (current?.contentHash === hash) return current;

  const bumped = await Alpha.findOneAndUpdate({ _id: alphaId, userId, deletedAt: null }, { $inc: { versionCounter: 1 } }, { new: true });
  const version = await AlphaVersion.create({ alphaId, userId, versionNumber: bumped.versionCounter, expression, settings, contentHash: hash, parentVersionId: current?._id ?? null, source, note });
  await Alpha.updateOne({ _id: alphaId, userId }, { $set: { currentVersionId: version._id, draft: null } });
  return version;
}

export async function restoreVersion(userId, alphaId, versionNumber) {
  if (!mongoose.isValidObjectId(alphaId)) throw new AppError(400, 'INVALID_ID', 'Alpha id is invalid');
  const old = await AlphaVersion.findOne({ alphaId, userId, versionNumber }).lean();
  if (!old) throw new AppError(404, 'NOT_FOUND', 'Version was not found');
  return saveVersion(userId, alphaId, { expression: old.expression, settings: old.settings, source: 'manual', note: `Restored from version ${versionNumber}` });
}
