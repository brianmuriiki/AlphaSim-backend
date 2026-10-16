import { Queue } from 'bullmq';
import { redis } from '../lib/redis.js';

export const simulationQueue = new Queue('simulations', { connection: redis, defaultJobOptions: { attempts: 3, backoff: { type: 'brain', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 } });
export const verificationQueue = new Queue('brain-verification', { connection: redis });
