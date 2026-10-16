import 'express-async-errors';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import mongoSanitize from 'express-mongo-sanitize';
import pinoHttp from 'pino-http';
import mongoose from 'mongoose';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { redis } from './lib/redis.js';
import routes from './routes.js';
import { AppError, errorHandler, notFound } from './lib/errors.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { simulationQueue } from './queue/index.js';
import { ExpressAdapter } from '@bull-board/express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import crypto from 'node:crypto';

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true }));
app.use((req, res, next) => {
  if (env.NODE_ENV === 'production' && !req.secure) return res.status(426).json({ error: { code: 'HTTPS_REQUIRED', message: 'Use a secure connection' } });
  next();
});
app.use(pinoHttp({
  logger,
  autoLogging: true,
  customLogLevel(_req, res, error) {
    if (error || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage(req, res) { return `HTTP ${req.method} ${req.url} ${res.statusCode}`; },
  customErrorMessage(req, res) { return `HTTP ${req.method} ${req.url} ${res.statusCode}`; },
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(mongoSanitize());
app.use(globalLimiter);

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.get('/readyz', async (_req, res, next) => {
  try {
    const mongodb = mongoose.connection.readyState === 1;
    const redisReady = (await redis.ping()) === 'PONG';
    const ready = mongodb && redisReady;
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', dependencies: { mongodb: mongodb ? 'connected' : 'disconnected', redis: redisReady ? 'connected' : 'disconnected' } });
  } catch (error) { next(new AppError(503, 'NOT_READY', 'Required dependencies are unavailable', { cause: error.message })); }
});
if (env.OPS_ADMIN_TOKEN) {
  function requireOps(req, res, next) {
    const provided = Buffer.from(req.get('x-ops-token') ?? '');
    const expected = Buffer.from(env.OPS_ADMIN_TOKEN);
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return res.status(404).end();
    next();
  }
  const board = new ExpressAdapter();
  board.setBasePath('/internal/queues');
  createBullBoard({ queues: [new BullMQAdapter(simulationQueue)], serverAdapter: board });
  app.use('/internal/queues', requireOps, board.getRouter());
  app.get('/internal/metrics', requireOps, async (_req, res) => res.json({ simulationQueue: await simulationQueue.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed') }));
}
app.use('/api/v1', routes);
app.use(notFound);
app.use(errorHandler);
