import pino from 'pino';

export interface LogEntry {
  time: number;
  level: string;
  msg: string;
  [key: string]: unknown;
}

const MAX_LOG_ENTRIES = 500;
const logBuffer: LogEntry[] = [];

const levelLabels: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

function serializeExtra(extra: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    out[key] = value instanceof Error ? { message: value.message, stack: value.stack } : value;
  }
  return out;
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  hooks: {
    // Captures every log call into an in-memory ring buffer (for the web
    // dashboard's /api/logs) before handing off to the normal pino-pretty
    // output -- doesn't change what gets printed to stdout.
    logMethod(inputArgs, method, level) {
      const [first, second] = inputArgs;
      const hasExtra = typeof first === 'object' && first !== null;
      const msg = hasExtra ? second : first;
      const extra = hasExtra ? serializeExtra(first as Record<string, unknown>) : {};

      logBuffer.push({
        time: Date.now(),
        level: levelLabels[level] || 'info',
        msg: typeof msg === 'string' ? msg : '',
        ...extra,
      });
      if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();

      return method.apply(this, inputArgs as any);
    },
  },
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'HH:MM:ss Z',
      ignore: 'pid,hostname',
    },
  },
});

// Newest first.
export function getRecentLogs(): LogEntry[] {
  return logBuffer.slice().reverse();
}
