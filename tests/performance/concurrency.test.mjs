import test from 'node:test';
import assert from 'node:assert';
import { startTestGateway } from '../_helpers/gateway-helper.mjs';

const REQUEST_BODY = JSON.stringify({
  model: 'gpt-5.4',
  instructions: 'performance',
  input: [{ role: 'user', content: 'ping' }],
  stream: true,
});

test('performance gateway can serve concurrent responses requests', async () => {
  const { gatewayPort, cleanup } = await startTestGateway({ supportsResponses: true });
  try {
    const requests = Array.from({ length: 4 }, () =>
      fetch(`http://127.0.0.1:${gatewayPort}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: REQUEST_BODY,
      }).then((res) => res.text())
    );
    const bodies = await Promise.all(requests);
    for (const body of bodies) {
      assert.ok(body.includes('response.completed'));
    }
  } finally {
    await cleanup();
  }
});
