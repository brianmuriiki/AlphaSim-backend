import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie', '*.password', '*.encryptedSession', '*.encryptedAiApiKey', '*.apiKey'],
    censor: '[REDACTED]'
  }
});
