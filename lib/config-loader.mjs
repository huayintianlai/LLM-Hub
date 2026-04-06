import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { resolveConfigReferences } from './env.mjs';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function loadGatewayConfig(configPath = process.env.GATEWAY_CONFIG || path.resolve(process.cwd(), 'config/gateway.yaml')) {
  const absolutePath = path.resolve(process.cwd(), configPath);
  const raw = fs.readFileSync(absolutePath, 'utf8');
  const parsed = YAML.parse(raw);
  const config = resolveConfigReferences(parsed);

  assert(config?.gateway?.ports?.length, 'gateway.ports is required');
  assert(Array.isArray(config.upstreams) && config.upstreams.length > 0, 'upstreams is required');

  config.configPath = absolutePath;
  config.gateway.host = config.gateway.host || '127.0.0.1';
  config.gateway.request_timeout_ms = Number(config.gateway.request_timeout_ms || 120000);

  for (const upstream of config.upstreams) {
    assert(upstream.id, 'upstream.id is required');
    assert(upstream.origin, `upstream.origin is required for ${upstream.id}`);
    upstream.priority = Number(upstream.priority || 100);
    upstream.timeout_ms = Number(upstream.timeout_ms || config.gateway.request_timeout_ms);
    upstream.capabilities = upstream.capabilities || {};
    upstream.model_map = upstream.model_map || {};
    upstream.cost = upstream.cost || {};
  }

  for (const listener of config.gateway.ports) {
    listener.port = Number(listener.port);
    listener.bind = listener.bind || config.gateway.host;
    listener.auth = listener.auth || {};
    listener.routing_strategy =
      listener.routing_strategy ||
      config?.failover?.routing_strategy?.[listener.app_name] ||
      'balanced';
  }

  config.database = config.database || { type: 'sqlite', path: './data/llmhub.db' };
  config.monitoring = config.monitoring || { enabled: false };
  config.failover = config.failover || {};
  config.failover.circuit_breaker = config.failover.circuit_breaker || {};

  return config;
}
