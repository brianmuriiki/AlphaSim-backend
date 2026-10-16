import { captureException } from './sentry.js';

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function notFound(req, res, next) {
  next(new AppError(404, 'NOT_FOUND', `No route for ${req.method} ${req.originalUrl}`));
}

export function errorHandler(error, req, res, _next) {
  if (res.headersSent) return res.end();
  const isZodError = error.name === 'ZodError';
  const isMongoValidationError = error.name === 'ValidationError';
  const isCastError = error.name === 'CastError';
  const status = error.status ?? (isZodError ? 422 : ((isMongoValidationError || isCastError) ? 400 : 500));
  const code = error.code ?? (isZodError ? 'VALIDATION_FAILED' : ((isMongoValidationError || isCastError) ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR'));
  if (status >= 500) captureException(error);
  const details = error.details ?? (isZodError ? error.issues.map(({ path, message }) => ({ path: path.join('.'), message })) : undefined);
  // AppError messages are authored operational errors (for example, a missing local mock
  // service or an unconfigured AI provider). Keep those actionable while masking unknown
  // exceptions that could contain internal implementation details.
  const message = error instanceof AppError ? error.message : status >= 500 ? 'An unexpected error occurred' : error.message;
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}

