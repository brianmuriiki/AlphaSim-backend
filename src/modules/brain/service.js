import { User } from '../../models/User.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { BrainClient, BrainError } from './brain.client.js';
import { AppError } from '../../lib/errors.js';
import { publishEvent } from '../../realtime/events.js';
import { env } from '../../config/env.js';
import { Datafield } from '../../models/Datafield.js';
import { Operator } from '../../models/Operator.js';

export async function refreshBrainCatalog(userId) {
  const user = await User.findOne({ _id: userId, 'brainConnection.status': 'connected' }).select('+brainConnection.encryptedSession');
  if (!user?.brainConnection?.encryptedSession) throw new AppError(409, 'BRAIN_NOT_CONNECTED', 'Connect BRAIN before refreshing the catalog');
  const client = await BrainClient.fromSession(decrypt(user.brainConnection.encryptedSession));
  let catalog;
  try { catalog = await client.getCatalog(); }
  catch (error) {
    if (error instanceof BrainError && error.code === 'SESSION_EXPIRED') {
      await User.updateOne({ _id: user._id }, { $set: { 'brainConnection.status': 'expired' } });
      await publishEvent(user._id, 'brain.expired', {});
    }
    throw error;
  }
  const fields = catalog.datafields.map((field) => ({ ...field, ownerUserId: user._id }));
  if (fields.length) await Datafield.bulkWrite(fields.map((field) => ({ updateOne: { filter: { ownerUserId: user._id, region: field.region, universe: field.universe, delay: field.delay, datasetId: field.datasetId, name: field.name }, update: { $set: field }, upsert: true } })), { ordered: false });
  if (catalog.operators.length) await Operator.bulkWrite(catalog.operators.map((operator) => ({ updateOne: { filter: { name: operator.name }, update: { $set: operator }, upsert: true } })), { ordered: false });
  const fieldKeys = fields.map(({ region, universe, delay, datasetId, name }) => ({ region, universe, delay, datasetId, name }));
  await Datafield.deleteMany({ ownerUserId: user._id, ...(fieldKeys.length ? { $nor: fieldKeys.map((key) => ({ region: key.region, universe: key.universe, delay: key.delay, datasetId: key.datasetId, name: key.name })) } : {}) });
  return { datafields: fields.length, operators: catalog.operators.length, refreshedAt: new Date() };
}

export async function connectBrain(userId, credentials) {
  const result = await BrainClient.login(credentials.email, credentials.password);
  const user = await User.findOneAndUpdate({ _id: userId }, { $set: { 'brainConnection.status': 'connected', 'brainConnection.encryptedSession': encrypt(result.cookie), 'brainConnection.sessionExpiresAt': new Date(Date.now() + env.BRAIN_SESSION_TTL_HOURS * 3600000), 'brainConnection.lastVerifiedAt': new Date(), 'brainConnection.mode': env.BRAIN_MODE } }, { new: true });
  if (!user) throw new AppError(404, 'NOT_FOUND', 'User was not found');
  try { await refreshBrainCatalog(userId); } catch { /* Catalog refresh is retried by the scheduled refresh. */ }
  await publishEvent(userId, 'brain.connected', { mode: env.BRAIN_MODE });
  return { status: 'connected', mode: env.BRAIN_MODE };
}

export async function refreshConnectedCatalogs() {
  const users = await User.find({ 'brainConnection.status': 'connected' }).select('_id').lean();
  const results = [];
  for (const user of users) {
    try { results.push({ userId: String(user._id), ...(await refreshBrainCatalog(user._id)) }); }
    catch { results.push({ userId: String(user._id), failed: true }); }
  }
  return results;
}

export async function brainStatus(userId) {
  const user = await User.findById(userId).select('brainConnection.status brainConnection.sessionExpiresAt brainConnection.lastVerifiedAt brainConnection.mode').lean();
  if (!user) throw new AppError(404, 'NOT_FOUND', 'User was not found');
  let status = user.brainConnection?.status ?? 'none';
  if (status === 'connected' && user.brainConnection.sessionExpiresAt && user.brainConnection.sessionExpiresAt <= new Date()) {
    status = 'expired';
    await User.updateOne({ _id: userId }, { $set: { 'brainConnection.status': 'expired' } });
    await publishEvent(userId, 'brain.expired', {});
  }
  return { status, sessionExpiresAt: user.brainConnection?.sessionExpiresAt, lastVerifiedAt: user.brainConnection?.lastVerifiedAt, mode: user.brainConnection?.mode ?? null };
}

export async function disconnectBrain(userId) {
  await User.updateOne({ _id: userId }, { $set: { brainConnection: { status: 'none' } } });
  return { status: 'none' };
}
