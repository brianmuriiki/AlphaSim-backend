import mongoose from 'mongoose';
import { User } from '../../models/User.js';
import { Alpha } from '../../models/Alpha.js';
import { Simulation } from '../../models/Simulation.js';
import { AlphaVersion } from '../../models/AlphaVersion.js';
import { simulationQueue } from '../../queue/index.js';
import { publishEvent } from '../../realtime/events.js';
import { saveVersion } from '../alphas/service.js';
import { lintExpression } from '../../lib/linter.js';
import { decrypt } from '../../lib/crypto.js';
import { BrainClient } from '../brain/brain.client.js';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { Experiment } from '../../models/Experiment.js';
import { storeRawResult } from '../../lib/gridfs.js';

async function reserveSlot(userId) {
  const userCap = Math.min(env.MAX_SIMS_PER_USER, env.BRAIN_CONCURRENCY_PER_USER);
  const user = await User.findOneAndUpdate({ _id: userId, 'brainConnection.status': 'connected', $expr: { $lt: ['$activeSimulationCount', userCap] } }, { $inc: { activeSimulationCount: 1 } }, { new: true }).select('+brainConnection.encryptedSession');
  if (!user) {
    const exists = await User.exists({ _id: userId });
    if (!exists) throw new AppError(404, 'NOT_FOUND', 'User was not found');
    const check = await User.findById(userId).select('brainConnection.status activeSimulationCount').lean();
    if (check.brainConnection?.status !== 'connected') throw new AppError(409, 'BRAIN_NOT_CONNECTED', 'Connect BRAIN before running a simulation');
    throw new AppError(429, 'TOO_MANY_ACTIVE', 'Active simulation limit reached');
  }
  return user;
}

export async function releaseSlot(simulation) {
  const updated = await Simulation.findOneAndUpdate({ _id: simulation._id, userId: simulation.userId, slotReleased: false }, { $set: { slotReleased: true } }, { new: true }).select('userId slotReserved');
  if (updated?.slotReserved) await User.updateOne({ _id: updated.userId, activeSimulationCount: { $gt: 0 } }, { $inc: { activeSimulationCount: -1 } });
}

async function updateExperiment(simulation, failed) {
  if (!simulation.experimentId) return;
  const experiment = await Experiment.findOneAndUpdate({ _id: simulation.experimentId, userId: simulation.userId }, { $inc: { 'progress.done': 1, ...(failed ? { 'progress.failed': 1 } : {}) } }, { new: true });
  if (!experiment) return;
  if (experiment.progress.done >= experiment.progress.total) {
    experiment.status = experiment.progress.failed === experiment.progress.total ? 'failed' : 'completed';
    await experiment.save();
  }
  await publishEvent(simulation.userId, 'experiment.progress', { id: experiment.id, done: experiment.progress.done, total: experiment.progress.total, failed: experiment.progress.failed });
}

export async function enqueueSnapshot(userId, { alphaId, versionId, expression, settings, source = 'manual', experimentId = null, deferSlot = false }) {
  if (!mongoose.isValidObjectId(alphaId)) throw new AppError(400, 'INVALID_ID', 'Alpha id is invalid');
  const alphaExists = await Alpha.exists({ _id: alphaId, userId, deletedAt: null });
  if (!alphaExists) throw new AppError(404, 'NOT_FOUND', 'Alpha was not found');
  if (deferSlot) {
    const connected = await User.exists({ _id: userId, 'brainConnection.status': 'connected' });
    if (!connected) throw new AppError(409, 'BRAIN_NOT_CONNECTED', 'Connect BRAIN before running a simulation');
  } else await reserveSlot(userId);
  let simulation;
  try {
    let version;
    if (versionId) {
      version = await AlphaVersion.findOne({ _id: versionId, alphaId, userId }).lean();
      if (!version) throw new AppError(404, 'NOT_FOUND', 'Alpha version was not found');
    } else {
      const lint = await lintExpression(expression, { ...settings, ownerUserId: userId });
      if (lint.errors.length) throw new AppError(422, 'INVALID_EXPRESSION', 'Expression has validation errors', lint.errors);
      version = await saveVersion(userId, alphaId, { expression, settings, source });
    }
    const lint = await lintExpression(version.expression, { ...version.settings, ownerUserId: userId });
    if (lint.errors.length) throw new AppError(422, 'INVALID_EXPRESSION', 'Expression has validation errors', lint.errors);
    const alpha = await Alpha.findOneAndUpdate({ _id: alphaId, userId, deletedAt: null }, { $inc: { runCounter: 1 } }, { new: true });
    simulation = await Simulation.create({ userId, alphaId, versionId: version._id, runNumber: alpha.runCounter, expressionSnapshot: version.expression, settingsSnapshot: version.settings ?? {}, status: 'queued', slotReserved: !deferSlot, experimentId, timing: { queuedAt: new Date() } });
    await simulationQueue.add('simulate', { simulationId: simulation.id, userId: String(userId) }, { jobId: simulation.id });
    await publishEvent(userId, 'simulation.queued', { id: simulation.id, runNumber: simulation.runNumber });
    return simulation;
  } catch (error) {
    if (simulation) {
      simulation.status = 'failed'; simulation.error = { code: 'QUEUE_FAILED', message: 'Unable to queue simulation' }; simulation.timing.finishedAt = new Date(); await simulation.save(); await releaseSlot(simulation);
    } else if (!deferSlot) await User.updateOne({ _id: userId, activeSimulationCount: { $gt: 0 } }, { $inc: { activeSimulationCount: -1 } });
    throw error;
  }
}

export async function acquireDeferredSlot(simulationId, userId) {
  const sim = await Simulation.findOne({ _id: simulationId, userId });
  if (!sim || ['cancelled', 'completed', 'failed'].includes(sim.status) || sim.slotReserved) return true;
  const cap = Math.min(env.MAX_SIMS_PER_USER, env.BRAIN_CONCURRENCY_PER_USER);
  const user = await User.findOneAndUpdate({ _id: userId, 'brainConnection.status': 'connected', $expr: { $lt: ['$activeSimulationCount', cap] } }, { $inc: { activeSimulationCount: 1 } }, { new: true }).select('_id');
  if (!user) {
    if (!await User.exists({ _id: userId, 'brainConnection.status': 'connected' })) throw new AppError(409, 'BRAIN_NOT_CONNECTED', 'Connect BRAIN before running a simulation');
    return false;
  }
  const claimed = await Simulation.updateOne({ _id: simulationId, userId, status: 'queued', slotReserved: false, slotReleased: false }, { $set: { slotReserved: true } });
  if (!claimed.modifiedCount) await User.updateOne({ _id: userId, activeSimulationCount: { $gt: 0 } }, { $inc: { activeSimulationCount: -1 } });
  return claimed.modifiedCount > 0;
}

export async function createSimulation(userId, input) { return enqueueSnapshot(userId, input); }

export async function retrySimulation(userId, simulationId) {
  const previous = await Simulation.findOne({ _id: simulationId, userId }).lean();
  if (!previous) throw new AppError(404, 'NOT_FOUND', 'Simulation was not found');
  if (previous.status !== 'failed') throw new AppError(409, 'SIMULATION_NOT_RETRYABLE', 'Only failed simulations can be retried');
  return enqueueSnapshot(userId, { alphaId: previous.alphaId, versionId: previous.versionId, expression: previous.expressionSnapshot, settings: previous.settingsSnapshot, experimentId: previous.experimentId });
}

export async function cancelSimulation(userId, simulationId) {
  const sim = await Simulation.findOneAndUpdate({ _id: simulationId, userId, status: { $in: ['queued', 'running'] } }, { $set: { status: 'cancelled', 'timing.finishedAt': new Date() } }, { new: true });
  if (!sim) {
    if (!await Simulation.exists({ _id: simulationId, userId })) throw new AppError(404, 'NOT_FOUND', 'Simulation was not found');
    throw new AppError(409, 'SIMULATION_NOT_CANCELLABLE', 'Simulation is already finished');
  }
  const job = await simulationQueue.getJob(sim.id);
  const state = job ? await job.getState() : null;
  if (job && ['waiting', 'delayed', 'paused'].includes(state)) { await job.remove(); await releaseSlot(sim); }
  else if (!job || ['completed', 'failed'].includes(state)) await releaseSlot(sim);
  await updateExperiment(sim, true);
  await publishEvent(userId, 'simulation.cancelled', { id: sim.id });
  return sim;
}

export async function listSimulations(userId, query = {}) {
  const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
  const filter = { userId };
  if (query.alphaId) filter.alphaId = query.alphaId;
  if (query.status) filter.status = query.status;
  if (query.cursor && mongoose.isValidObjectId(query.cursor)) filter._id = { $lt: query.cursor };
  const items = await Simulation.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const hasMore = items.length > limit;
  if (hasMore) items.pop();
  return { items, nextCursor: hasMore ? String(items.at(-1)._id) : null };
}

export async function getSimulation(userId, id) {
  if (!mongoose.isValidObjectId(id)) throw new AppError(400, 'INVALID_ID', 'Simulation id is invalid');
  const sim = await Simulation.findOne({ _id: id, userId }).lean();
  if (!sim) throw new AppError(404, 'NOT_FOUND', 'Simulation was not found');
  return sim;
}

export async function compareSimulations(userId, ids) {
  if (!ids || ids.length < 2 || ids.length > 5 || ids.some((id) => !mongoose.isValidObjectId(id))) throw new AppError(400, 'INVALID_IDS', 'Provide between two and five simulation ids');
  const rows = await Simulation.find({ _id: { $in: ids }, userId }).lean();
  if (rows.length !== new Set(ids).size) throw new AppError(404, 'NOT_FOUND', 'One or more simulations were not found');
  return rows;
}

export async function executeSimulation(simulationId, userId, onProgress) {
  const sim = await Simulation.findOne({ _id: simulationId, userId });
  if (!sim) return;
  if (['cancelled', 'completed', 'failed'].includes(sim.status)) { await releaseSlot(sim); return; }
  const user = await User.findOne({ _id: userId }).select('+brainConnection.encryptedSession');
  if (!user || user.brainConnection?.status !== 'connected' || !user.brainConnection.encryptedSession) throw new AppError(401, 'SESSION_EXPIRED', 'BRAIN connection expired');
  if (user.brainConnection.sessionExpiresAt && user.brainConnection.sessionExpiresAt <= new Date()) throw new AppError(401, 'SESSION_EXPIRED', 'BRAIN connection expired');
  const session = decrypt(user.brainConnection.encryptedSession);
  const client = await BrainClient.fromSession(session);
  const startedAt = new Date();
  const started = await Simulation.updateOne({ _id: sim.id, userId, status: { $in: ['queued', 'running'] } }, { $set: { status: 'running', 'timing.startedAt': startedAt } });
  if (!started.modifiedCount) { await releaseSlot(sim); return; }
  await publishEvent(sim.userId, 'simulation.running', { id: sim.id });
  const response = await client.runSimulation({ expression: sim.expressionSnapshot, settings: sim.settingsSnapshot, progressUrl: sim.brainProgressUrl, onSubmitted: async (url) => Simulation.updateOne({ _id: sim._id, userId }, { $set: { brainProgressUrl: url } }), onProgress: async (progress) => {
      onProgress?.(progress);
      await publishEvent(sim.userId, 'simulation.progress', { id: sim.id, progress });
    }, isCancelled: async () => {
      const current = await Simulation.findOne({ _id: sim.id, userId }).select('status').lean();
      return !current || current.status === 'cancelled';
    } });
  const latest = await Simulation.findOne({ alphaId: sim.alphaId, userId, status: 'completed' }).sort({ runNumber: -1 }).select('result').lean();
  const delta = {};
  for (const key of ['sharpe', 'fitness', 'turnover', 'returns', 'drawdown', 'margin']) if (typeof response.result[key] === 'number' && typeof latest?.result?.[key] === 'number') delta[key] = response.result[key] - latest.result[key];
  const rawResultRef = await storeRawResult(sim.id, sim.userId, response.raw);
  const chartResult = { ...response.result, pnl: downsample(response.result.pnl ?? [], 2000) };
  const completed = await Simulation.findOneAndUpdate({ _id: sim.id, userId, status: { $ne: 'cancelled' } }, { $set: { status: 'completed', result: chartResult, deltaVsPrevious: delta, rawResultRef, brainAlphaId: response.brainAlphaId, 'timing.finishedAt': new Date() } }, { new: true });
  if (!completed) return;
  const alpha = await Alpha.findOne({ _id: sim.alphaId, userId: sim.userId }).select('bestMetrics').lean();
  if (typeof response.result.sharpe === 'number' && (alpha?.bestMetrics?.sharpe == null || response.result.sharpe > alpha.bestMetrics.sharpe)) {
    await Alpha.updateOne({ _id: sim.alphaId, userId: sim.userId }, { $set: { bestMetrics: { sharpe: response.result.sharpe, fitness: response.result.fitness, turnover: response.result.turnover } } });
  }
  await publishEvent(sim.userId, 'simulation.completed', { id: sim.id, summary: { runNumber: sim.runNumber, status: completed.status, source: response.result.source ?? 'brain', metrics: { sharpe: response.result.sharpe, fitness: response.result.fitness, turnover: response.result.turnover, returns: response.result.returns, drawdown: response.result.drawdown, margin: response.result.margin } } });
  await updateExperiment(sim, false);
  await releaseSlot(sim);
}

export async function recordFailure(simulationId, userId, error, willRetry) {
  const sim = await Simulation.findOne({ _id: simulationId, userId });
  if (!sim) return;
  if (['cancelled', 'completed', 'failed'].includes(sim.status)) { await releaseSlot(sim); return; }
  if (willRetry) {
    await Simulation.updateOne({ _id: sim._id, userId }, { $set: { status: 'queued', error: { code: error.code ?? 'TRANSIENT_ERROR', message: 'Simulation is retrying' } } });
    await publishEvent(sim.userId, 'simulation.progress', { id: sim.id, status: 'retrying' });
    return;
  }
  await Simulation.updateOne({ _id: sim._id, userId }, { $set: { status: 'failed', error: { code: error.code ?? 'SIMULATION_FAILED', message: error.message ?? 'Simulation failed' }, 'timing.finishedAt': new Date() } });
  await releaseSlot(sim);
  if (error.code === 'SESSION_EXPIRED') {
    await User.updateOne({ _id: sim.userId }, { $set: { 'brainConnection.status': 'expired' } });
    await publishEvent(sim.userId, 'brain.expired', {});
  }
  await publishEvent(sim.userId, 'simulation.failed', { id: sim.id, error: { code: error.code ?? 'SIMULATION_FAILED', message: error.message ?? 'Simulation failed' } });
  await updateExperiment(sim, true);
}

function downsample(points, maxPoints) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points;
  const output = []; const step = (points.length - 1) / (maxPoints - 1);
  for (let index = 0; index < maxPoints; index += 1) output.push(points[Math.round(index * step)]);
  return output;
}
