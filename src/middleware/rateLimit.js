import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redis } from '../lib/redis.js';

function store(prefix) { return new RedisStore({ prefix, sendCommand: (...args) => redis.call(...args) }); }
const handler = (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many requests; try again later' } });
export const globalLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false, store: store('alphasim:rl:global:'), handler });
export const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, store: store('alphasim:rl:auth:'), keyGenerator: (req) => req.ip, handler });
export const simulationLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, store: store('alphasim:rl:sim:'), keyGenerator: (req) => req.userId ?? req.ip, handler });
