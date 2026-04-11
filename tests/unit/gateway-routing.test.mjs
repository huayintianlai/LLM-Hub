import test from 'node:test';
import assert from 'node:assert';
import { GatewayApp } from '../../lib/gateway.mjs';

const logger = {
  child() {
    return this;
  },
  warn() {},
  info() {},
  debug() {},
  error() {},
};

function createGatewayApp(routingMode) {
  return new GatewayApp({
    gateway: {
      host: '127.0.0.1',
      request_timeout_ms: 60000,
      ports: [],
    },
    upstreams: [
      {
        id: 'passthrough',
        name: 'passthrough',
        origin: 'https://passthrough.example',
        responses_full_path: '/openai/responses',
        chat_full_path: '/openai/v1/chat/completions',
        api_key: 'test',
        timeout_ms: 30000,
        priority: 1,
        supported_models: ['gpt-5.4'],
        model_aliases: { gpt: 'gpt-5.4' },
        model_map: { gpt: 'gpt-5.4' },
        capabilities: {
          supports_responses: true,
          supports_chat_completions: true,
          responses_requires_stream: false,
          responses_always_streams: false,
          chat_requires_stream: false,
          chat_always_streams: false,
        },
        cost: {},
      },
      {
        id: 'transform',
        name: 'transform',
        origin: 'https://transform.example',
        responses_full_path: '/openai/responses',
        chat_full_path: '/openai/v1/chat/completions',
        api_key: 'test',
        timeout_ms: 30000,
        priority: 2,
        supported_models: ['gpt-5.4'],
        model_aliases: { gpt: 'gpt-5.4' },
        model_map: { gpt: 'gpt-5.4' },
        capabilities: {
          supports_responses: false,
          supports_chat_completions: true,
          responses_requires_stream: false,
          responses_always_streams: false,
          chat_requires_stream: false,
          chat_always_streams: false,
        },
        cost: {},
      },
    ],
    failover: {
      routing_mode: routingMode,
      circuit_breaker: {
        failure_threshold: 3,
        initial_cooldown: 1,
        max_cooldown: 5,
        exponential_backoff: true,
      },
    },
    database: { type: 'sqlite', path: '/tmp/llmhub-route-plan-test.sqlite' },
    monitoring: { enabled: false },
  }, logger);
}

function setLatency(app, upstreamId, latencyMs) {
  const state = app.upstreamManager.getState(upstreamId);
  state.average_latency_ms = latencyMs;
  state.rolling_avg_latency_ms = latencyMs;
  state.recent_success_rate = 1.0;
}

test('dynamic routing can promote transform route ahead of passthrough route', () => {
  const app = createGatewayApp('dynamic');
  setLatency(app, 'passthrough', 25000);
  setLatency(app, 'transform', 500);

  const routePlan = app.buildRoutePlan(
    'responses',
    { model: 'gpt-5.4', stream: true },
    { app_name: 'codex-cli', routing_strategy: 'latency-first' }
  );

  assert.deepStrictEqual(
    routePlan.map((route) => `${route.upstream.id}:${route.mode}`),
    ['transform:transform', 'passthrough:passthrough']
  );
});

test('static routing still keeps passthrough routes ahead of transform routes', () => {
  const app = createGatewayApp('static');
  setLatency(app, 'passthrough', 25000);
  setLatency(app, 'transform', 500);

  const routePlan = app.buildRoutePlan(
    'responses',
    { model: 'gpt-5.4', stream: true },
    { app_name: 'codex-cli', routing_strategy: 'latency-first' }
  );

  assert.deepStrictEqual(
    routePlan.map((route) => `${route.upstream.id}:${route.mode}`),
    ['passthrough:passthrough', 'transform:transform']
  );
});
