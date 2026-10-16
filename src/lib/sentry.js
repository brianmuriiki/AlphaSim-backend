import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';

let initialized = false;
export function initializeSentry() {
  if (!env.SENTRY_DSN || initialized) return;
  Sentry.init({ dsn: env.SENTRY_DSN, environment: env.NODE_ENV, beforeSend(event) {
    if (event.request) {
      delete event.request.data;
      if (event.request.headers) { delete event.request.headers.authorization; delete event.request.headers.cookie; }
    }
    return event;
  } });
  initialized = true;
}
export function captureException(error) { if (env.SENTRY_DSN) Sentry.captureException(error); }
