import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { createRedisClient } from '../lib/redis.js';
import { eventChannel } from './events.js';

export function attachRealtime(httpServer) {
  const io = new Server(httpServer, { cors: { origin: env.CLIENT_ORIGIN, credentials: true } });
  const subscriber = createRedisClient();
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) throw new Error('missing');
      socket.userId = jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: 'alphasim' }).sub;
      next();
    } catch { next(new Error('UNAUTHENTICATED')); }
  });
  io.on('connection', (socket) => socket.join(`user:${socket.userId}`));
  subscriber.subscribe(eventChannel);
  subscriber.on('message', (_channel, raw) => {
    try {
      const message = JSON.parse(raw);
      io.to(`user:${message.userId}`).emit(message.event, message.payload);
    } catch (error) { console.error('Invalid realtime event payload', error.message); }
  });
  return { io, close: async () => { await subscriber.quit(); await io.close(); } };
}
