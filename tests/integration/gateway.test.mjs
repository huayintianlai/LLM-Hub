import test from 'node:test';
import assert from 'node:assert';
import { startTestGateway } from '../_helpers/gateway-helper.mjs';

const REQUEST_BODY = JSON.stringify({
  model: 'gpt-5.4',
  instructions: 'integration test',
  input: [{ role: 'user', content: 'hello' }],
  stream: true,
});

const CHAT_REQUEST_BODY = JSON.stringify({
  model: 'gpt-5.4',
  messages: [{ role: 'user', content: 'hello' }],
  stream: true,
});

async function fetchResponses(port) {
  const res = await fetch(`http://127.0.0.1:${port}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: REQUEST_BODY,
  });
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  return text;
}

async function fetchChatCompletions(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: CHAT_REQUEST_BODY,
  });
  assert.strictEqual(res.status, 200);
  return res.text();
}

test('integration passthrough keeps upstream SSE payloads', async () => {
  const { gatewayPort, cleanup } = await startTestGateway({ supportsResponses: true });
  try {
    const body = await fetchResponses(gatewayPort);
    assert.ok(body.includes('response.completed'));
    const status = await fetch(`http://127.0.0.1:${gatewayPort}/status`).then((res) => res.json());
    assert.strictEqual(status.ok, true);
    assert.strictEqual(status.listener, 'codex-cli');
  } finally {
    await cleanup();
  }
});

test('integration passthrough rewrites aliased model names before forwarding upstream', async () => {
  const { gatewayPort, cleanup } = await startTestGateway({
    supportsResponses: true,
    modelMap: { laojin: 'claude-opus-4-6' },
    responsesEvents: ({ requestBody }) => [
      {
        event: 'response.completed',
        payload: {
          type: 'response.completed',
          response: {
            id: 'resp_alias',
            status: 'completed',
            model: requestBody.model,
            usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
          },
        },
      },
    ],
  });
  try {
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'laojin',
        instructions: 'integration test',
        input: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('claude-opus-4-6'));
  } finally {
    await cleanup();
  }
});

test('integration transform uses chat completions SSE streamer', async () => {
  const { gatewayPort, cleanup } = await startTestGateway({ supportsResponses: false });
  try {
    const body = await fetchResponses(gatewayPort);
    assert.ok(body.includes('response.output_text.delta'));
    assert.ok(body.includes('response.completed'));
  } finally {
    await cleanup();
  }
});

test('integration passthrough chat streaming records usage when upstream requires include_usage', async () => {
  const { gatewayPort, dashboardPort, cleanup } = await startTestGateway({
    supportsResponses: true,
    monitoringEnabled: true,
    chatUsageRequiresInclude: true,
  });
  try {
    await fetchChatCompletions(gatewayPort);
    const requests = await fetch(`http://127.0.0.1:${dashboardPort}/api/requests`).then((res) => res.json());
    assert.strictEqual(requests[0].request_protocol, 'chat_completions');
    assert.strictEqual(requests[0].tokens_total, 3);
    assert.ok(requests[0].cost_usd > 0);
  } finally {
    await cleanup();
  }
});

test('integration transform streaming records usage when upstream requires include_usage', async () => {
  const { gatewayPort, dashboardPort, cleanup } = await startTestGateway({
    supportsResponses: false,
    monitoringEnabled: true,
    chatUsageRequiresInclude: true,
  });
  try {
    await fetchResponses(gatewayPort);
    const requests = await fetch(`http://127.0.0.1:${dashboardPort}/api/requests`).then((res) => res.json());
    assert.strictEqual(requests[0].request_protocol, 'responses');
    assert.strictEqual(requests[0].tokens_total, 3);
    assert.ok(requests[0].cost_usd > 0);
  } finally {
    await cleanup();
  }
});

test('integration transform can collapse always-streaming chat upstream into JSON', async () => {
  const { gatewayPort, cleanup } = await startTestGateway({ supportsResponses: false });
  try {
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        instructions: 'integration test',
        input: [{ role: 'user', content: 'hello' }],
        stream: false,
      }),
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.status, 'completed');
    assert.ok(json.output[0].content[0].text.includes('transformed'));
  } finally {
    await cleanup();
  }
});

test('integration dashboard APIs expose summary, requests and upstreams', async () => {
  const { gatewayPort, dashboardPort, cleanup } = await startTestGateway({
    supportsResponses: true,
    monitoringEnabled: true,
  });
  try {
    await fetchResponses(gatewayPort);
    assert.ok(dashboardPort);
    const summary = await fetch(`http://127.0.0.1:${dashboardPort}/api/summary`).then((res) => res.json());
    assert.ok(typeof summary.total_requests === 'number');
    assert.strictEqual(summary.tokens_total, 3);
    assert.strictEqual(summary.failed_requests, 0);
    assert.ok(Array.isArray(summary.upstreams));
    assert.strictEqual(summary.upstreams[0].upstream_id, 'mock');
    assert.strictEqual(summary.upstreams[0].tokens_total, 3);
    assert.ok(Array.isArray(summary.trend));
    assert.ok(summary.trend.length >= 1);
    assert.ok(summary.trend.some((bucket) => bucket.total_requests >= 1));
    const requests = await fetch(`http://127.0.0.1:${dashboardPort}/api/requests`).then((res) => res.json());
    assert.ok(Array.isArray(requests));
    assert.strictEqual(requests[0].tokens_total, 3);
    const upstreams = await fetch(`http://127.0.0.1:${dashboardPort}/api/upstreams`).then((res) => res.json());
    assert.ok(Array.isArray(upstreams.memory));
    assert.ok(Array.isArray(upstreams.persisted));
    const config = await fetch(`http://127.0.0.1:${dashboardPort}/api/config`).then((res) => res.json());
    assert.strictEqual(config.upstreams[0].api_key, '[REDACTED]');
    const meta = await fetch(`http://127.0.0.1:${dashboardPort}/api/meta`).then((res) => res.json());
    assert.strictEqual(meta.app, 'llm-hub');
    assert.strictEqual(meta.version, '0.1.0');
    assert.ok(meta.dashboard_path.endsWith('dashboard/index.html'));
    const health = await fetch(`http://127.0.0.1:${dashboardPort}/health`).then((res) => res.json());
    assert.strictEqual(health.ok, true);
    assert.strictEqual(health.scope, 'dashboard');
  } finally {
    await cleanup();
  }
});

test('integration dashboard requests API supports query filters', async () => {
  const { gatewayPort, dashboardPort, cleanup } = await startTestGateway({
    supportsResponses: true,
    monitoringEnabled: true,
  });
  try {
    await fetchResponses(gatewayPort);
    const filtered = await fetch(
      `http://127.0.0.1:${dashboardPort}/api/requests?limit=20&hours=24&app_name=codex-cli&upstream_id=mock&route_mode=passthrough`
    ).then((res) => res.json());
    assert.ok(Array.isArray(filtered));
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].app_name, 'codex-cli');
    assert.strictEqual(filtered[0].upstream_id, 'mock');
    assert.strictEqual(filtered[0].route_mode, 'passthrough');
  } finally {
    await cleanup();
  }
});
