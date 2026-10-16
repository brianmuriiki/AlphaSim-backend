import mongoose from 'mongoose';
import { Worker, DelayedError } from 'bullmq';
import { env } from '../config/env.js';
import { redis } from '../lib/redis.js';
import { acquireDeferredSlot, executeSimulation, recordFailure } from '../modules/simulations/service.js';
import { captureException, initializeSentry } from '../lib/sentry.js';
import { Alpha } from '../models/Alpha.js';
import { AlphaVersion } from '../models/AlphaVersion.js';
import { Simulation } from '../models/Simulation.js';
import { deleteSimulationRawResults } from '../lib/gridfs.js';

initializeSentry();
await mongoose.connect(env.MONGODB_URI);
const worker = new Worker('simulations', async (job, token) => {
  const { simulationId, userId } = job.data;
  try {
    const hasCapacity = await acquireDeferredSlot(simulationId, userId);
    if (!hasCapacity) {
      await job.moveToDelayed(Date.now() + 5000, token);
      throw new DelayedError();
    }
    await executeSimulation(simulationId, userId, (progress) => job.updateProgress(progress));
  } catch (error) {
    if (error instanceof DelayedError) throw error;
    if (!error.retryable) captureException(error);
    const retryable = error.retryable === true || ['TIMEOUT', 'BRAIN_UNAVAILABLE', 'RATE_LIMITED'].includes(error.code) || (error.status >= 500 && error.code !== 'BRAIN_ADAPTER_UNAVAILABLE');
    const willRetry = retryable && job.attemptsMade + 1 < (job.opts.attempts ?? 1);
    await recordFailure(simulationId, userId, error, willRetry);
    if (willRetry) throw error;
  }
}, {
  connection: redis,
  concurrency: env.WORKER_CONCURRENCY,
  settings: { backoffStrategy: (attemptsMade, _type, error) => Math.min(error?.retryAfterMs || 5000 * (2 ** Math.max(0, attemptsMade - 1)), 120000) }
});

async function purgeSoftDeletedAlphas() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const expired = await Alpha.find({ deletedAt: { $lte: cutoff } }).select('_id userId').lean();
  for (const alpha of expired) {
    const simulations = await Simulation.find({ alphaId: alpha._id, userId: alpha.userId }).select('_id').lean();
    await deleteSimulationRawResults(simulations.map((item) => item._id), alpha.userId);
    await Promise.all([
      Simulation.deleteMany({ alphaId: alpha._id, userId: alpha.userId }),
      AlphaVersion.deleteMany({ alphaId: alpha._id, userId: alpha.userId }),
      Alpha.deleteOne({ _id: alpha._id, userId: alpha.userId, deletedAt: { $lte: cutoff } })
    ]);
  }
}
purgeSoftDeletedAlphas().catch(captureException);
const purgeTimer = setInterval(() => purgeSoftDeletedAlphas().catch(captureException), 24 * 60 * 60 * 1000);
purgeTimer.unref();

async function shutdown() {
  await worker.close();
  clearInterval(purgeTimer);
  await mongoose.disconnect();
  await redis.quit();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
