import { redis } from '../lib/redis.js';
const channel = 'alphasim:events';
export async function publishEvent(userId, event, payload) {
  try { await redis.publish(channel, JSON.stringify({ userId: String(userId), event, payload, at: new Date().toISOString() })); }
  catch (error) { console.error('Unable to publish realtime event', { event, error: error.message }); }
}
export { channel as eventChannel };
