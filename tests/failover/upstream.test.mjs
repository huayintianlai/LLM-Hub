import test from 'node:test';
import assert from 'node:assert';
import { UpstreamManager } from '../../lib/upstream-manager.mjs';

const logger = {
  child() {
    return this;
  },
  warn() {},
  info() {},
  debug() {},
  error() {},
};

const upstreams = [
  {
    id: 'u1',
    name: 'u1',
    origin: 'https://example.com',
    responses_full_path: '/openai/responses',
    chat_full_path: '/openai/v1/chat/completions',
    api_key: 'x',
    capabilities: { supports_responses: true, supports_chat_completions: true },
    model_map: {},
    cost: {},
  },
];

const failoverConfig = {
  upstreams,
  failover: {
    circuit_breaker: {
      failure_threshold: 2,
      initial_cooldown: 1,
      max_cooldown: 5,
      exponential_backoff: false,
    },
  },
};

class DummyDb {
  recordUpstreamState() {}
  recordRequest() {}
}

test('circuit breaker opens after consecutive failures', () => {
  const manager = new UpstreamManager(failoverConfig, new DummyDb(), logger);
  manager.registerFailure('u1', 'error one');
  manager.registerFailure('u1', 'error two');
  const state = manager.getState('u1');
  assert.strictEqual(state.circuit_state, 'open');
  assert.ok(state.cooldown_until > Date.now());
  assert.strictEqual(manager.isAvailable('u1'), false);
});

test('success resets circuit breaker state', () => {
  const manager = new UpstreamManager(failoverConfig, new DummyDb(), logger);
  manager.registerFailure('u1', 'error');
  manager.registerFailure('u1', 'error');
  manager.registerSuccess('u1', 120, 200);
  const state = manager.getState('u1');
  assert.strictEqual(state.circuit_state, 'closed');
  assert.strictEqual(state.consecutive_failures, 0);
  assert.strictEqual(state.failure_count, 2);
});
