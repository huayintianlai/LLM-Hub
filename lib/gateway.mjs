import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import { DatabaseAdapter } from './database.mjs';
import { sendMacNotification } from './notifications.mjs';
import {
  buildGatewayPath,
  buildUpstreamUrl,
  detectProtocol,
  extractUsage,
  mapModel,
  supportsPassthrough,
  supportsTransform,
  transformResponsesRequestToChat,
} from './protocol.mjs';
import { createSseParser } from './sse.mjs';
import { UpstreamManager } from './upstream-manager.mjs';
import { ChatToResponsesStreamBridge, collectChatCompletionFromSse } from './chat-to-responses.mjs';

function sanitizeResponseHeaders(headers) {
  const result = {};
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (lower === 'content-length' || lower === 'connection' || lower === 'transfer-encoding') {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function json(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    connection: 'close',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
}

function parseJsonBody(buffer) {
  if (!buffer || !buffer.length) {
    return null;
  }
  return JSON.parse(buffer.toString('utf8'));
}

function computeCost(upstream, usage) {
  if (!usage) {
    return 0;
  }
  const promptCost = Number(upstream.cost?.per_1k_prompt || 0);
  const completionCost = Number(upstream.cost?.per_1k_completion || 0);
  return Number(
    (
      ((usage.prompt || usage.input_tokens || 0) / 1000) * promptCost +
      ((usage.completion || usage.output_tokens || 0) / 1000) * completionCost
    ).toFixed(6)
  );
}

function buildModelsPayload(config) {
  const ids = new Set();
  const data = [];
  for (const upstream of config.upstreams) {
    for (const modelId of Object.keys(upstream.model_map || {})) {
      if (ids.has(modelId)) {
        continue;
      }
      ids.add(modelId);
      data.push({
        id: modelId,
        object: 'model',
        created: 0,
        owned_by: upstream.id,
      });
    }
  }
  return { object: 'list', data };
}

async function streamFetchBody(response, res, protocol) {
  const headers = sanitizeResponseHeaders(response.headers);
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const usageState = { usage: null, model: null };

  if (!response.body) {
    res.writeHead(response.status, headers);
    res.end();
    return usageState;
  }

  if (!contentType.includes('text/event-stream')) {
    const text = await response.text();
    if (contentType.includes('application/json')) {
      try {
        const payload = JSON.parse(text);
        usageState.usage = extractUsage(protocol, payload);
        usageState.model = payload.model || payload.response?.model || null;
      } catch {
        // noop
      }
    }
    const body = Buffer.from(text, 'utf8');
    res.writeHead(response.status, {
      ...headers,
      'content-length': String(body.length),
    });
    res.end(body);
    return usageState;
  }

  const parser = createSseParser(({ data }) => {
    if (!data || data === '[DONE]') {
      return;
    }
    try {
      const payload = JSON.parse(data);
      usageState.usage = extractUsage(protocol, payload);
      usageState.model = payload.model || payload.response?.model || usageState.model;
    } catch {
      // noop
    }
  });

  const nodeStream = Readable.fromWeb(response.body);
  res.writeHead(response.status, headers);
  for await (const chunk of nodeStream) {
    parser.feed(chunk);
    res.write(chunk);
  }
  parser.end();
  res.end();
  return usageState;
}

export class GatewayApp {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.database = new DatabaseAdapter(config.database, logger.child('db'));
    this.upstreamManager = new UpstreamManager(config, this.database, logger.child('upstreams'));
    this.servers = [];
    this.dashboardServer = null;
    this.modelsPayload = buildModelsPayload(config);
  }

  async init() {
    await this.database.init();
    for (const state of this.upstreamManager.snapshot()) {
      this.database.recordUpstreamState(state);
    }
  }

  async start() {
    await this.init();

    for (const listener of this.config.gateway.ports) {
      const server = http.createServer((req, res) => {
        this.handleGatewayRequest(listener, req, res).catch((error) => {
          this.logger.error('request failed', {
            listener: listener.app_name,
            error: error.message,
          });
          if (!res.headersSent) {
            json(res, 500, { error: 'Internal Server Error', message: error.message });
          } else {
            res.end();
          }
        });
      });
      await new Promise((resolve) => server.listen(listener.port, listener.bind, resolve));
      this.logger.info('listener started', {
        app_name: listener.app_name,
        bind: listener.bind,
        port: listener.port,
      });
      this.servers.push(server);
    }

    if (this.config.monitoring.enabled) {
      await this.startDashboardServer();
    }
  }

  async startDashboardServer() {
    const host = this.config.monitoring.dashboard_host || '127.0.0.1';
    const port = Number(this.config.monitoring.dashboard_port || 8080);
    const dashboardFile = path.resolve(process.cwd(), 'dashboard/index.html');

    this.dashboardServer = http.createServer((req, res) => {
      this.handleDashboardRequest(req, res, dashboardFile).catch((error) => {
        this.logger.error('dashboard request failed', { error: error.message });
        json(res, 500, { error: error.message });
      });
    });

    await new Promise((resolve) => this.dashboardServer.listen(port, host, resolve));
    this.logger.info('dashboard started', { host, port });
  }

  async stop() {
    for (const server of this.servers) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (this.dashboardServer) {
      await new Promise((resolve) => this.dashboardServer.close(resolve));
    }
    await this.database.close();
  }

  async handleDashboardRequest(req, res, dashboardFile) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const content = fs.readFileSync(dashboardFile, 'utf8');
      const body = Buffer.from(content, 'utf8');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(body.length),
      });
      res.end(body);
      return;
    }

    if (url.pathname === '/api/summary') {
      json(res, 200, await this.database.getSummary(Number(url.searchParams.get('hours') || 24)));
      return;
    }
    if (url.pathname === '/api/requests') {
      json(res, 200, await this.database.getRecentRequests(Number(url.searchParams.get('limit') || 50)));
      return;
    }
    if (url.pathname === '/api/upstreams') {
      json(res, 200, {
        memory: this.upstreamManager.snapshot(),
        persisted: await this.database.getUpstreamStates(),
      });
      return;
    }
    if (url.pathname === '/api/config') {
      json(res, 200, this.config);
      return;
    }

    json(res, 404, { error: 'Not Found' });
  }

  buildRoutePlan(protocol, requestBody, listener) {
    const strategy = listener.routing_strategy || 'balanced';
    const upstreamIds = this.upstreamManager.getOrderedUpstreams(strategy);
    const passthrough = [];
    const transform = [];

    for (const upstreamId of upstreamIds) {
      const upstream = this.upstreamManager.getUpstream(upstreamId);
      if (!upstream) {
        continue;
      }
      if (supportsPassthrough(protocol, requestBody, upstream)) {
        passthrough.push({ mode: 'passthrough', upstream });
      } else if (supportsTransform(protocol, upstream, requestBody)) {
        transform.push({ mode: 'transform', upstream });
      }
    }

    return [...passthrough, ...transform];
  }

  async notifyCritical(message) {
    if (!this.config.monitoring?.notifications?.enabled) {
      return;
    }
    await sendMacNotification('LLM-Hub', message, this.logger.child('notify'));
  }

  async handleGatewayRequest(listener, req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = buildGatewayPath(url.pathname);
    const protocol = detectProtocol(pathname);

    if (req.method === 'GET' && pathname === '/health') {
      json(res, 200, {
        ok: true,
        listener: listener.app_name,
        port: listener.port,
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/status') {
      json(res, 200, {
        ok: true,
        listener: listener.app_name,
        upstreams: this.upstreamManager.snapshot(),
        summary: await this.database.getSummary(24),
      });
      return;
    }

    if (req.method === 'GET' && protocol === 'models') {
      json(res, 200, this.modelsPayload);
      return;
    }

    if (protocol === 'unknown') {
      json(res, 404, { error: 'Not Found', pathname });
      return;
    }

    if (listener.auth?.require_bearer && !req.headers.authorization) {
      json(res, 401, { error: 'Unauthorized' });
      return;
    }

    const requestId = `req_${crypto.randomUUID()}`;
    const requestStartedAt = Date.now();
    const bodyBuffer = await readBody(req);
    let requestBody = null;

    try {
      requestBody = parseJsonBody(bodyBuffer);
    } catch (error) {
      json(res, 400, { error: 'Invalid JSON', message: error.message });
      return;
    }

    const routePlan = this.buildRoutePlan(protocol, requestBody, listener);
    if (!routePlan.length) {
      await this.notifyCritical(`${listener.app_name} has no upstream for protocol ${protocol}`);
      json(res, 503, { error: 'No upstream available', protocol, app_name: listener.app_name });
      return;
    }

    const attempts = [];
    for (const route of routePlan) {
      const startedAt = Date.now();
      try {
        const result =
          route.mode === 'passthrough'
            ? await this.executePassthrough({
                req,
                res,
                requestBody,
                bodyBuffer,
                listener,
                protocol,
                route,
                url,
              })
            : await this.executeTransform({
                req,
                res,
                requestBody,
                listener,
                route,
                url,
              });

        const latencyMs = Date.now() - startedAt;
        this.upstreamManager.registerSuccess(route.upstream.id, latencyMs, result.statusCode);
        this.database.recordRequest({
          timestamp: requestStartedAt,
          request_id: requestId,
          upstream_id: route.upstream.id,
          model: result.model || mapModel(requestBody?.model, route.upstream),
          app_name: listener.app_name,
          app_port: listener.port,
          request_protocol: protocol,
          route_mode: route.mode,
          success: true,
          latency_ms: latencyMs,
          status_code: result.statusCode,
          tokens_prompt: result.usage?.prompt || result.usage?.input_tokens || 0,
          tokens_completion: result.usage?.completion || result.usage?.output_tokens || 0,
          tokens_total: result.usage?.total || result.usage?.total_tokens || 0,
          cost_usd: computeCost(route.upstream, result.usage),
          metadata: {
            attempts,
            warnings: result.warnings || [],
          },
        });
        return;
      } catch (error) {
        attempts.push({
          upstream_id: route.upstream.id,
          mode: route.mode,
          error: error.message,
        });
        this.upstreamManager.registerFailure(route.upstream.id, error.message);
      }
    }

    this.database.recordRequest({
      timestamp: requestStartedAt,
      request_id: requestId,
      upstream_id: null,
      model: requestBody?.model || null,
      app_name: listener.app_name,
      app_port: listener.port,
      request_protocol: protocol,
      route_mode: 'failed',
      success: false,
      latency_ms: Date.now() - requestStartedAt,
      status_code: 503,
      error_type: 'all_upstreams_failed',
      error_message: attempts.map((item) => item.error).join('; '),
      metadata: { attempts },
    });
    await this.notifyCritical(`${listener.app_name} request failed on all upstreams`);
    json(res, 503, {
      error: 'All upstreams failed',
      attempts,
    });
  }

  async executePassthrough({ req, res, requestBody, bodyBuffer, protocol, route, url }) {
    const upstreamUrl = buildUpstreamUrl(route.upstream, protocol, url.search);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), route.upstream.timeout_ms);
    const headers = {
      authorization: `Bearer ${route.upstream.api_key}`,
      'content-type': req.headers['content-type'] || 'application/json',
      accept: req.headers.accept || '*/*',
      'user-agent': req.headers['user-agent'] || 'llm-hub/0.1',
    };

    if (bodyBuffer.length) {
      headers['content-length'] = String(bodyBuffer.length);
    }

    const response = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: bodyBuffer.length ? bodyBuffer : undefined,
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Upstream ${route.upstream.id} returned ${response.status}: ${text.slice(0, 200)}`);
    }

    const metadata = await streamFetchBody(response, res, protocol);
    return {
      statusCode: response.status,
      usage: metadata.usage,
      model: metadata.model || requestBody?.model || null,
      warnings: [],
    };
  }

  async executeTransform({ req, res, requestBody, route, url }) {
    const { chatRequest, warnings } = transformResponsesRequestToChat(requestBody, route.upstream);
    const upstreamUrl = buildUpstreamUrl(route.upstream, 'chat_completions', url.search);
    const payload = Buffer.from(JSON.stringify(chatRequest), 'utf8');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), route.upstream.timeout_ms);

    const response = await fetch(upstreamUrl, {
      method: req.method,
      headers: {
        authorization: `Bearer ${route.upstream.api_key}`,
        'content-type': 'application/json',
        'content-length': String(payload.length),
        accept: 'text/event-stream, application/json',
      },
      body: payload,
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Transform upstream ${route.upstream.id} returned ${response.status}: ${text.slice(0, 200)}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const bridge = new ChatToResponsesStreamBridge({
      requestBody,
      upstreamId: route.upstream.id,
      model: chatRequest.model,
    });

    if (requestBody?.stream === false) {
      let payloadJson;
      if (contentType.includes('text/event-stream')) {
        payloadJson = await collectChatCompletionFromSse(Readable.fromWeb(response.body));
      } else {
        const text = await response.text();
        payloadJson = JSON.parse(text);
      }
      const transformed = bridge.buildJsonResponse(payloadJson);
      const body = Buffer.from(JSON.stringify(transformed), 'utf8');
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(body.length),
      });
      res.end(body);
      return {
        statusCode: 200,
        usage: {
          prompt: transformed.usage?.input_tokens || 0,
          completion: transformed.usage?.output_tokens || 0,
          total: transformed.usage?.total_tokens || 0,
        },
        model: transformed.model,
        warnings,
      };
    }

    if (!contentType.includes('text/event-stream')) {
      const payloadJson = await response.json();
      const transformed = bridge.buildJsonResponse(payloadJson);
      const sseBridge = new ChatToResponsesStreamBridge({
        requestBody,
        upstreamId: route.upstream.id,
        model: transformed.model,
      });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      sseBridge.writeInitialEvents(res);
      for (const item of transformed.output) {
        if (item.type === 'message') {
          sseBridge.messageItem = {
            ...item,
            status: 'in_progress',
            content: [],
          };
          sseBridge.messageText = item.content?.[0]?.text || '';
        }
      }
      sseBridge.complete(res, transformed.usage, transformed.model);
      res.end();
      return {
        statusCode: 200,
        usage: {
          prompt: transformed.usage?.input_tokens || 0,
          completion: transformed.usage?.output_tokens || 0,
          total: transformed.usage?.total_tokens || 0,
        },
        model: transformed.model,
        warnings,
      };
    }

    const nodeStream = Readable.fromWeb(response.body);
    nodeStream.statusCode = response.status;
    const result = await bridge.transformStreaming(nodeStream, res);
    return {
      statusCode: 200,
      usage: {
        prompt: result.usage?.input_tokens || 0,
        completion: result.usage?.output_tokens || 0,
        total: result.usage?.total_tokens || 0,
      },
      model: result.model,
      warnings,
    };
  }
}
