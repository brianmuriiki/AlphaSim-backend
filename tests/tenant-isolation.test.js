import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import net from 'node:net';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { Datafield } from '../src/models/Datafield.js';

// Keep the MongoDB-memory-server's temporary port probe on loopback, which also
// works in restricted developer containers that deny wildcard interface binds.
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function listenOnLoopback(...args) {
  if (typeof args[0] === 'number') {
    if (args.length === 1) args.push('127.0.0.1');
    else if (typeof args[1] === 'function') args.splice(1, 0, '127.0.0.1');
  }
  return originalListen.apply(this, args);
};

vi.mock('../src/middleware/rateLimit.js', () => ({ globalLimiter: (_req, _res, next) => next(), authLimiter: (_req, _res, next) => next(), simulationLimiter: (_req, _res, next) => next() }));
vi.mock('rate-limit-redis', () => ({ RedisStore: class RedisStore {
  async increment() { return { totalHits: 0, resetTime: new Date(Date.now() + 60000) }; }
  async decrement() {}
  async resetKey() {}
} }));
vi.mock('../src/lib/redis.js', () => ({ redis: { call: vi.fn(), publish: vi.fn(), ping: vi.fn().mockResolvedValue('PONG'), quit: vi.fn() }, createRedisClient: () => ({ subscribe: vi.fn(), on: vi.fn(), quit: vi.fn() }) }));
vi.mock('../src/queue/index.js', () => ({ simulationQueue: { add: vi.fn(), getJob: vi.fn() }, verificationQueue: { add: vi.fn() } }));

const { app } = await import('../src/app.js');
let mongo; let user1; let user2;

describe('tenant isolation', () => {
  beforeAll(async () => { mongo = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } }); await mongoose.connect(mongo.getUri()); });
  beforeEach(async () => {
    await mongoose.connection.db.dropDatabase();
    const first = await request(app).post('/api/v1/auth/register').send({ email: 'one@example.com', password: 'long-test-password-1', displayName: 'One' });
    const second = await request(app).post('/api/v1/auth/register').send({ email: 'two@example.com', password: 'long-test-password-2', displayName: 'Two' });
    user1 = first.body.data; user2 = second.body.data;
  });
  afterAll(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });

  it('hides another user alpha behind NOT_FOUND', async () => {
    const created = await request(app).post('/api/v1/alphas').set('Authorization', `Bearer ${user1.accessToken}`).send({ name: 'Private alpha', expression: 'rank(close)' }).expect(201);
    await request(app).get(`/api/v1/alphas/${created.body.data._id}`).set('Authorization', `Bearer ${user2.accessToken}`).expect(404);
    const list = await request(app).get('/api/v1/alphas').set('Authorization', `Bearer ${user2.accessToken}`).expect(200);
    expect(list.body.data).toHaveLength(0);
  });

  it('does not expose another user datafield catalog entries', async () => {
    await Datafield.create({ ownerUserId: user1.user.id, region: 'USA', universe: 'TOP3000', delay: 1, datasetId: 'private', name: 'private_signal', description: 'Private catalog entry' });
    const first = await request(app).get('/api/v1/datafields').set('Authorization', `Bearer ${user1.accessToken}`).expect(200);
    const second = await request(app).get('/api/v1/datafields').set('Authorization', `Bearer ${user2.accessToken}`).expect(200);
    expect(first.body.items.map((field) => field.name)).toContain('private_signal');
    expect(second.body.items.map((field) => field.name)).not.toContain('private_signal');
  });
});
