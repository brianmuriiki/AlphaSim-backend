import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/alphasim'),
  REDIS_URL: z.string().url().default('redis://127.0.0.1:6379'),
  JWT_ACCESS_SECRET: z.string().min(32).default('development-access-secret-change-me-32chars'),
  JWT_REFRESH_SECRET: z.string().min(32).default('development-refresh-secret-change-me-32'),
  ENCRYPTION_KEY: z.string().default('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='),
  BRAIN_MODE: z.enum(['mock', 'disabled', 'official']).default('mock'),
  BRAIN_BASE_URL: z.preprocess((value) => value === '' ? undefined : value, z.string().url().optional()),
  MOCK_BRAIN_URL: z.string().url().default('http://127.0.0.1:4011'),
  BRAIN_SESSION_TTL_HOURS: z.coerce.number().positive().default(4),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_SITE_URL: z.string().url().default('http://localhost:5173'),
  AI_MODEL: z.string().default('openrouter/free'),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(90000),
  AI_MONTHLY_TOKEN_BUDGET: z.coerce.number().int().positive().default(100000),
  SENTRY_DSN: z.preprocess((value) => value === '' ? undefined : value, z.string().url().optional()),
  OPS_ADMIN_TOKEN: z.preprocess((value) => value === '' ? undefined : value, z.string().min(32).optional()),
  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
  MAX_SIMS_PER_USER: z.coerce.number().int().positive().default(2),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(3),
  BRAIN_MAX_WAIT_MS: z.coerce.number().int().positive().default(900000),
  BRAIN_CONCURRENCY_PER_USER: z.coerce.number().int().positive().default(2)
}).superRefine((value, ctx) => {
  if (Buffer.from(value.ENCRYPTION_KEY, 'base64').length !== 32) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ENCRYPTION_KEY'], message: 'ENCRYPTION_KEY must be base64 for exactly 32 random bytes' });
  }
  if (value.NODE_ENV === 'production' && (value.JWT_ACCESS_SECRET.startsWith('development-') || value.JWT_REFRESH_SECRET.startsWith('development-'))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['JWT_ACCESS_SECRET'], message: 'Production requires dedicated random token secrets' });
  }
  if (value.NODE_ENV === 'production' && value.ENCRYPTION_KEY === 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ENCRYPTION_KEY'], message: 'Production requires a newly generated encryption key' });
  }
  if (value.NODE_ENV === 'production' && value.BRAIN_MODE === 'mock') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['BRAIN_MODE'], message: 'Mock BRAIN mode is for development and tests only' });
  }
  if (value.BRAIN_MODE === 'official' && !value.BRAIN_BASE_URL) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['BRAIN_BASE_URL'], message: 'BRAIN_BASE_URL is required for official adapter mode' });
  }
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const env = parsed.data;
