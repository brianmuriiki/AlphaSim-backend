import mongoose from 'mongoose';
import { app } from './app.js';
import { env } from './config/env.js';
import { attachRealtime } from './realtime/gateway.js';
import { redis } from './lib/redis.js';
import { seedBuiltinOperators } from './lib/seed.js';
import { captureException, initializeSentry } from './lib/sentry.js';
import { refreshConnectedCatalogs } from './modules/brain/service.js';

initializeSentry();
await mongoose.connect(env.MONGODB_URI);
await redis.ping();
await seedBuiltinOperators();
refreshConnectedCatalogs().catch(captureException);
const catalogTimer = setInterval(() => refreshConnectedCatalogs().catch(captureException), 6 * 60 * 60 * 1000);
catalogTimer.unref();
const server = app.listen(env.PORT);
const realtime = attachRealtime(server);

async function shutdown() {
  server.close(async () => {
    await realtime.close();
    clearInterval(catalogTimer);
    await mongoose.disconnect();
    await redis.quit();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
