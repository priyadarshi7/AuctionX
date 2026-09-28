import pino, { type LoggerOptions } from 'pino';
import { env } from '../../config/env';

const options: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: ['req.headers.authorization', 'req.headers.cookie'],
};

if (env.NODE_ENV === 'development') {
  options.transport = { target: 'pino-pretty', options: { colorize: true } };
}

export const logger = pino(options);
