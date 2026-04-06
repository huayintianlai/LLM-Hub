import test from 'node:test';
import assert from 'node:assert';
import { startTestGateway } from '../_helpers/gateway-helper.mjs';

const REQUEST_BODY = JSON.stringify({
  model: 'gpt-5.4',
  instructions: 'integration test',
  input: [{ role: 'user', content: 'hello' }],
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
    const requests = await fetch(`http://127.0.0.1:${dashboardPort}/api/requests`).then((res) => res.json());
    assert.ok(Array.isArray(requests));
    const upstreams = await fetch(`http://127.0.0.1:${dashboardPort}/api/upstreams`).then((res) => res.json());
    assert.ok(Array.isArray(upstreams.memory));
    assert.ok(Array.isArray(upstreams.persisted));
  } finally {
    await cleanup();
  }
});
