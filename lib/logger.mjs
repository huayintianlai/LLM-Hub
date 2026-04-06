import fs from 'node:fs';
import path from 'node:path';

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function createLogger({ scope = 'llmhub', logFile = path.resolve(process.cwd(), 'logs/gateway.log') } = {}) {
  ensureDir(logFile);

  function emit(level, message, meta) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      scope,
      message,
      ...(meta && Object.keys(meta).length ? { meta } : {}),
    };
    const line = JSON.stringify(entry);
    if (level === 'ERROR' || level === 'WARN') {
      console.error(line);
    } else {
      console.log(line);
    }
    fs.appendFileSync(logFile, `${line}\n`);
  }

  return {
    child(childScope) {
      return createLogger({ scope: `${scope}:${childScope}`, logFile });
    },
    debug(message, meta) {
      emit('DEBUG', message, meta);
    },
    info(message, meta) {
      emit('INFO', message, meta);
    },
    warn(message, meta) {
      emit('WARN', message, meta);
    },
    error(message, meta) {
      emit('ERROR', message, meta);
    },
  };
}
