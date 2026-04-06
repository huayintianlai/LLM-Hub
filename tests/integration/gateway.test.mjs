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

test('integration dashboard requests API ignores invalid query params instead of failing', async () => {
  const { gatewayPort, dashboardPort, cleanup } = await startTestGateway({
    supportsResponses: true,
    monitoringEnabled: true,
  });
  try {
    await fetchResponses(gatewayPort);
    const res = await fetch(
      `http://127.0.0.1:${dashboardPort}/api/requests?limit=NaN&hours=abc&app_name=%20%20&upstream_id=%20mock%20&route_mode=%20passthrough%20`
    );
    assert.strictEqual(res.status, 200);
    const filtered = await res.json();
    assert.ok(Array.isArray(filtered));
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].upstream_id, 'mock');
    assert.strictEqual(filtered[0].route_mode, 'passthrough');
  } finally {
    await cleanup();
  }
});

test('integration failover success sends openclaw notification', async () => {
  const openClawRequests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'http://openclaw.test/api/message/send') {
      openClawRequests.push({
        url,
        headers: init?.headers,
        body: JSON.parse(init?.body || '{}'),
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return originalFetch(input, init);
  };

  const { gatewayPort, cleanup } = await startTestGateway({
    monitoringEnabled: true,
    openClawConfig: {
      gatewayUrl: 'http://openclaw.test',
      gatewayToken: 'notify-token',
      agentId: 'agent-123',
      userId: 'user-456',
    },
    upstreams: [
      {
        id: 'primary',
        supportsResponses: true,
        priority: 1,
        responsesHandler: (_req, res) => {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('primary failed');
        },
        chatHandler: (_req, res) => {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('primary failed');
        },
      },
      {
        id: 'backup',
        supportsResponses: true,
        priority: 2,
        responsesHandler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
          res.write('event: response.completed\n');
          res.write(`data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_backup',
              status: 'completed',
              model: 'gpt-5.4',
              usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
            },
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        },
        chatHandler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
          res.write(`data: ${JSON.stringify({
            choices: [{ delta: { content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            model: 'gpt-5.4',
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        },
      },
    ],
  });

  try {
    const body = await fetchResponses(gatewayPort);
    assert.ok(body.includes('response.completed'));
    assert.strictEqual(openClawRequests.length, 1);
    assert.strictEqual(openClawRequests[0].url, 'http://openclaw.test/api/message/send');
    assert.strictEqual(openClawRequests[0].body.agent_id, 'agent-123');
    assert.strictEqual(openClawRequests[0].body.user_id, 'user-456');
    assert.strictEqual(openClawRequests[0].body.metadata.event_type, 'upstream_failover');
    assert.strictEqual(openClawRequests[0].body.metadata.from_upstream_id, 'primary');
    assert.strictEqual(openClawRequests[0].body.metadata.to_upstream_id, 'backup');
    assert.ok(openClawRequests[0].body.metadata.reason.includes('primary returned 502'));
    assert.ok(openClawRequests[0].body.message.includes('渠道切换'));
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

test('integration openclaw failure does not break successful failover request', async () => {
  const openClawRequests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'http://openclaw.test/api/message/send') {
      openClawRequests.push({
        url,
        headers: init?.headers,
        body: JSON.parse(init?.body || '{}'),
      });
      return new Response(JSON.stringify({ ok: false }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    return originalFetch(input, init);
  };

  const { gatewayPort, cleanup } = await startTestGateway({
    monitoringEnabled: true,
    openClawConfig: {
      gatewayUrl: 'http://openclaw.test',
      gatewayToken: 'notify-token',
      agentId: 'agent-123',
      userId: 'user-456',
    },
    upstreams: [
      {
        id: 'primary',
        supportsResponses: true,
        priority: 1,
        responsesHandler: (_req, res) => {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('primary failed');
        },
        chatHandler: (_req, res) => {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('primary failed');
        },
      },
      {
        id: 'backup',
        supportsResponses: true,
        priority: 2,
        responsesHandler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
          res.write('event: response.completed\n');
          res.write(`data: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_backup',
              status: 'completed',
              model: 'gpt-5.4',
              usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
            },
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        },
        chatHandler: (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
          res.write(`data: ${JSON.stringify({
            choices: [{ delta: { content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            model: 'gpt-5.4',
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        },
      },
    ],
  });

  try {
    const body = await fetchResponses(gatewayPort);
    assert.ok(body.includes('response.completed'));
    assert.strictEqual(openClawRequests.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});
