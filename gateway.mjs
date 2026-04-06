#!/usr/bin/env node

import { loadEnvFiles } from './lib/env.mjs';
import { createLogger } from './lib/logger.mjs';
import { loadGatewayConfig } from './lib/config-loader.mjs';
import { GatewayApp } from './lib/gateway.mjs';

loadEnvFiles();

const logger = createLogger();
const config = loadGatewayConfig();
const app = new GatewayApp(config, logger);

try {
  await app.start();
} catch (error) {
  logger.error('failed to start gateway', { error: error.message });
  process.exit(1);
}

async function shutdown(signal) {
  logger.info('shutting down gateway', { signal });
  await app.stop();
  process.exit(0);
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    logger.error('shutdown failed', { error: error.message });
    process.exit(1);
  });
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    logger.error('shutdown failed', { error: error.message });
    process.exit(1);
  });
});
