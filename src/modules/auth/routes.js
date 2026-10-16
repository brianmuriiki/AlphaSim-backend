import { Router } from 'express';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { z } from 'zod';
import { User } from '../../models/User.js';
import { RefreshToken } from '../../models/RefreshToken.js';
import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';

export const authRoutes = Router();
const registerSchema = z.object({ email: z.string().email().max(254), password: z.string().min(12).max(128), displayName: z.string().trim().min(1).max(80) });
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(128) });

const refreshCookie = 'alphasim_refresh';
const refreshLifetimeMs = 30 * 24 * 60 * 60 * 1000;
const cookieOptions = { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'strict', path: '/api/v1/auth', maxAge: refreshLifetimeMs };
function issueAccessToken(userId) {
  return jwt.sign({}, env.JWT_ACCESS_SECRET, { subject: String(userId), issuer: 'alphasim', expiresIn: '15m' });
}
function hashToken(token) { return crypto.createHmac('sha256', env.JWT_REFRESH_SECRET).update(token).digest('hex'); }
async function issueTokens(userId) {
  const refresh = crypto.randomBytes(48).toString('base64url');
  await RefreshToken.create({ userId, tokenHash: hashToken(refresh), expiresAt: new Date(Date.now() + refreshLifetimeMs) });
  return { accessToken: issueAccessToken(userId), refresh };
}
function sendTokens(res, tokens, status = 200) {
  res.cookie(refreshCookie, tokens.refresh, cookieOptions);
  res.status(status).json({ data: { accessToken: tokens.accessToken } });
}

authRoutes.post('/register', async (req, res, next) => {
  try {
    const input = registerSchema.parse(req.body);
    const passwordHash = await argon2.hash(input.password);
    const user = await User.create({ email: input.email, displayName: input.displayName, passwordHash });
    const tokens = await issueTokens(user.id);
    req.userId = user.id;
    await audit(req, 'auth.register');
    res.cookie(refreshCookie, tokens.refresh, cookieOptions).status(201).json({ data: { user: { id: user.id, email: user.email, displayName: user.displayName }, accessToken: tokens.accessToken } });
  } catch (error) {
    if (error.code === 11000) return next(new AppError(409, 'EMAIL_IN_USE', 'An account with this email already exists'));
    next(error);
  }
});

authRoutes.post('/login', async (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);
    const user = await User.findOne({ email: input.email.toLowerCase() }).select('+passwordHash');
    if (!user || !(await argon2.verify(user.passwordHash, input.password))) throw new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    const tokens = await issueTokens(user.id);
    req.userId = user.id;
    await audit(req, 'auth.login');
    res.cookie(refreshCookie, tokens.refresh, cookieOptions).json({ data: { user: { id: user.id, email: user.email, displayName: user.displayName }, accessToken: tokens.accessToken } });
  } catch (error) { next(error); }
});

authRoutes.post('/refresh', async (req, res, next) => {
  try {
    const raw = req.cookies?.[refreshCookie];
    if (!raw) throw new AppError(401, 'INVALID_REFRESH', 'Refresh token is missing or invalid');
    const tokenHash = hashToken(raw);
    const record = await RefreshToken.findOne({ tokenHash });
    if (!record || record.expiresAt <= new Date()) throw new AppError(401, 'INVALID_REFRESH', 'Refresh token is missing or invalid');
    if (record.revokedAt) {
      await RefreshToken.updateMany({ userId: record.userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
      throw new AppError(401, 'REFRESH_REUSED', 'Refresh token reuse detected; sign in again');
    }
    const claimed = await RefreshToken.findOneAndUpdate({ _id: record._id, revokedAt: null }, { $set: { revokedAt: new Date() } }, { new: true });
    if (!claimed) {
      await RefreshToken.updateMany({ userId: record.userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
      throw new AppError(401, 'REFRESH_REUSED', 'Refresh token reuse detected; sign in again');
    }
    const tokens = await issueTokens(record.userId);
    sendTokens(res, tokens);
  } catch (error) { next(error); }
});

authRoutes.post('/logout', async (req, res, next) => {
  try {
    const raw = req.cookies?.[refreshCookie];
    if (raw) {
      const record = await RefreshToken.findOne({ tokenHash: hashToken(raw) }).select('userId');
      if (record) await RefreshToken.updateOne({ _id: record._id, userId: record.userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
    }
    res.clearCookie(refreshCookie, { ...cookieOptions, maxAge: undefined }).status(204).end();
  } catch (error) { next(error); }
});
