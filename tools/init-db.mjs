#!/usr/bin/env node

import { loadEnvFiles } from '../lib/env.mjs';
import { loadGatewayConfig } from '../lib/config-loader.mjs';
import { DatabaseAdapter } from '../lib/database.mjs';

loadEnvFiles();
const config = loadGatewayConfig();

const consoleLogger = {
  info: (...args) => console.log('[db:init]', ...args),
  warn: (...args) => console.warn('[db:init]', ...args),
  error: (...args) => console.error('[db:init]', ...args),
  child() {
    return this;
  },
};

(async () => {
  const adapter = new DatabaseAdapter(config.database, consoleLogger);
  await adapter.init();
  consoleLogger.info('database schema ensured for', config.database.path);
})();
