import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { GatewayApp } from '../../lib/gateway.mjs';
import { createLogger } from '../../lib/logger.mjs';

function buildSse(res, events) {
  const headers = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  };
  res.writeHead(200, headers);
  for (const { event, payload } of events) {
    if (event) {
      res.write(`event: ${event}\n`);
    }
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

const defaultResponsesEvents = [
  {
    event: 'response.created',
    payload: {
      type: 'response.created',
      response: { id: 'resp_default', status: 'in_progress', model: 'gpt-5.4' },
    },
  },
  {
    event: 'response.output_text.delta',
    payload: {
      type: 'response.output_text.delta',
      content_index: 0,
      delta: 'hello',
      item_id: 'msg_default',
      output_index: 0,
    },
  },
  {
    event: 'response.completed',
    payload: {
      type: 'response.completed',
      response: {
        id: 'resp_default',
        status: 'completed',
        model: 'gpt-5.4',
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      },
    },
  },
];

const defaultChatEvents = [
  {
    payload: { choices: [{ delta: { content: 'transformed ' } }], model: 'gpt-5.4' },
  },
  {
    payload: {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    },
  },
];

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMockUpstream({ responsesHandler, chatHandler }) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const bodyText = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
    const body = bodyText ? JSON.parse(bodyText) : null;

    if (req.url && req.url.startsWith('/openai/responses')) {
      return responsesHandler(req, res, body);
    }
    if (req.url && req.url.startsWith('/openai/v1/chat/completions')) {
      return chatHandler(req, res, body);
    }
    res.writeHead(404);
    res.end('not found');
  });
  return server;
}

function randomTempPath(prefix, suffix) {
  const token = crypto.randomBytes(8).toString('hex');
  return path.join(os.tmpdir(), `${prefix}-${token}${suffix}`);
}

export async function startTestGateway({
  supportsResponses = true,
  monitoringEnabled = false,
  responsesEvents = defaultResponsesEvents,
  chatEvents = defaultChatEvents,
  chatUsageRequiresInclude = false,
  modelMap = { 'gpt-5.4': 'gpt-5.4' },
} = {}) {
  const upstreamServer = createMockUpstream({
    responsesHandler: (req, res, body) => {
      const events = typeof responsesEvents === 'function' ? responsesEvents({ requestBody: body }) : responsesEvents;
      buildSse(res, events);
    },
    chatHandler: (req, res, body) => {
      const events = typeof chatEvents === 'function' ? chatEvents({ requestBody: body }) : chatEvents;
      const shouldIncludeUsage = !chatUsageRequiresInclude || body?.stream_options?.include_usage === true;
      const normalized = shouldIncludeUsage
        ? events
        : events.map((event) => {
            const nextEvent = cloneJson(event);
            delete nextEvent.usage;
            return nextEvent;
          });
      buildSse(res, normalized);
    },
  });
  await new Promise((resolve, reject) => upstreamServer.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve())));

  const upstreamPort = upstreamServer.address().port;
  const dbPath = randomTempPath('llmhub-db', '.sqlite');
  const logPath = randomTempPath('llmhub-log', '.log');
  const config = {
    gateway: {
      host: '127.0.0.1',
      request_timeout_ms: 60000,
      ports: [
        {
          port: 0,
          app_name: 'codex-cli',
          auth: { require_bearer: false },
          routing_strategy: 'latency-first',
        },
      ],
    },
    upstreams: [
      {
        id: 'mock',
        name: 'mock',
        origin: `http://127.0.0.1:${upstreamPort}`,
        responses_full_path: '/openai/responses',
        chat_full_path: '/openai/v1/chat/completions',
        api_key: 'test',
        timeout_ms: 30000,
        capabilities: {
          supports_responses: Boolean(supportsResponses),
          supports_chat_completions: true,
          responses_requires_stream: true,
          responses_always_streams: true,
        },
        model_map: modelMap,
        cost: { per_1k_prompt: 0.01, per_1k_completion: 0.03 },
      },
    ],
    failover: {
      circuit_breaker: { failure_threshold: 3, initial_cooldown: 1, max_cooldown: 5, exponential_backoff: true },
      routing_strategy: { 'codex-cli': 'latency-first' },
    },
    database: { type: 'sqlite', path: dbPath },
    monitoring: { enabled: monitoringEnabled, dashboard_port: 0, dashboard_host: '127.0.0.1', notifications: { enabled: false } },
  };
  const logger = createLogger({ logFile: logPath });
  const app = new GatewayApp(config, logger);
  await app.start();
  const gatewayPort = app.servers[0].address().port;
  const dashboardPort = app.dashboardServer ? app.dashboardServer.address().port : null;

  const cleanup = async () => {
    await app.stop();
    await new Promise((resolve) => upstreamServer.close(resolve));
    await fs.rm(dbPath, { force: true }).catch(() => {});
    await fs.rm(logPath, { force: true }).catch(() => {});
  };

  return { app, gatewayPort, dashboardPort, cleanup };
}
