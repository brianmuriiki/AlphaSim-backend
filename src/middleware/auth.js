import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';

export function requireAuth(req, _res, next) {
  const token = req.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return next(new AppError(401, 'AUTH_REQUIRED', 'Sign in to continue'));
  try {
    req.userId = jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: 'alphasim' }).sub;
    if (typeof req.log?.child === 'function') req.log = req.log.child({ userId: req.userId });
    return next();
  } catch {
    return next(new AppError(401, 'INVALID_TOKEN', 'Your session is invalid or expired'));
  }
}
