import pino from 'pino';
import { env } from '../config/env.js';

// Create logger with configuration based on environment
export const logger = pino({
  level: env.LOG_LEVEL,
  transport: env.LOG_PRETTY
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
});

// Export logger instance for application-wide use
export default logger;
