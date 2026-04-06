import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import { DatabaseAdapter } from './database.mjs';
import {
  getOpenClawNotificationConfig,
  sendMacNotification,
  sendOpenClawNotification,
} from './notifications.mjs';
import {
  buildGatewayPath,
  buildUpstreamUrl,
  detectProtocol,
  ensureChatStreamIncludesUsage,
  extractUsageDetails,
  mapModel,
  upstreamSupportsRequestedModel,
  supportsPassthrough,
  supportsTransform,
  transformResponsesRequestToChat,
} from './protocol.mjs';
import { createSseParser } from './sse.mjs';
import { UpstreamManager } from './upstream-manager.mjs';
import { ChatToResponsesStreamBridge, collectChatCompletionFromSse } from './chat-to-responses.mjs';
import {
  countResponsesRequestTokens,
  countResponsesResponseTokens,
  countStreamResponseTokens,
  countChatRequestTokens,
} from './token-counter.mjs';

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

function loadPackageManifest() {
  try {
    const raw = fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function formatFailoverTimestamp(timestamp) {
  return new Date(timestamp).toISOString();
}

function buildFailoverNotification({ listener, protocol, requestId, requestBody, attempts, route, timestamp }) {
  const previousAttempt = attempts[attempts.length - 1] || null;
  if (!previousAttempt) {
    return null;
  }

  const model = requestBody?.model || null;
  const reason = previousAttempt.error || 'unknown upstream error';
  const when = formatFailoverTimestamp(timestamp);
  const message = [
    'LLM-Hub 发生渠道切换。',
    `时间：${when}`,
    `动作：${listener.app_name} 的 ${protocol} 请求从 ${previousAttempt.upstream_id} 切换到 ${route.upstream.id}`,
    `原因：${reason}`,
    model ? `模型：${model}` : null,
    `请求 ID：${requestId}`,
  ].filter(Boolean).join('；');

  return {
    message,
    metadata: {
      event_type: 'upstream_failover',
      timestamp: when,
      app_name: listener.app_name,
      protocol,
      model,
      request_id: requestId,
      from_upstream_id: previousAttempt.upstream_id,
      to_upstream_id: route.upstream.id,
      reason,
    },
  };
}

function isSensitiveConfigKey(key) {
  return /(^|_)(api_?key|token|secret|password)$/i.test(key);
}

function sanitizeConfigForDashboard(value, key = '') {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeConfigForDashboard(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => {
        if (isSensitiveConfigKey(childKey)) {
          return [childKey, '[REDACTED]'];
        }
        return [childKey, sanitizeConfigForDashboard(childValue, childKey)];
      })
    );
  }

  if (typeof value === 'string' && isSensitiveConfigKey(key)) {
    return '[REDACTED]';
  }

  return value;
}

async function streamFetchBody(response, res, protocol, requestBody, model) {
  const headers = sanitizeResponseHeaders(response.headers);
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const usageState = { usage: null, model: null };
  let accumulatedText = ''; // 用于累积流式响应文本

  if (!response.body) {
    res.writeHead(response.status, headers);
    res.end();
    return usageState;
  }

  if (!contentType.includes('text/event-stream')) {
    const text = await response.text();
    let modifiedText = text;

    if (contentType.includes('application/json')) {
      try {
        const payload = JSON.parse(text);
        const details = extractUsageDetails(protocol, payload);

        console.log('[Passthrough JSON] Usage extraction:', {
          protocol,
          hasUsage: details.hasUsage,
          usage: details.usage,
          payloadUsage: payload.usage,
          payloadResponseUsage: payload.response?.usage,
        });

        if (details.hasUsage) {
          usageState.usage = details.usage;
        } else {
          // 如果没有 usage，使用 token 计数器
          if (protocol === 'responses') {
            const responseTokens = countResponsesResponseTokens(payload, model);
            const requestTokens = countResponsesRequestTokens(requestBody, model);
            usageState.usage = {
              prompt: requestTokens.prompt,
              completion: responseTokens.completion,
              total: requestTokens.prompt + responseTokens.completion,
            };
            console.log('[Passthrough JSON] Token counter fallback:', usageState.usage);

            // 注入计算出的 usage 到响应体
            if (payload.usage) {
              payload.usage.input_tokens = usageState.usage.prompt;
              payload.usage.output_tokens = usageState.usage.completion;
              payload.usage.total_tokens = usageState.usage.total;
            } else {
              payload.usage = {
                input_tokens: usageState.usage.prompt,
                output_tokens: usageState.usage.completion,
                total_tokens: usageState.usage.total,
              };
            }
            modifiedText = JSON.stringify(payload);
            console.log('[Passthrough JSON] Injected usage into response');
          }
        }
        usageState.model = payload.model || payload.response?.model || null;
      } catch {
        // noop
      }
    }
    const body = Buffer.from(modifiedText, 'utf8');
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
      const details = extractUsageDetails(protocol, payload);
      if (details.hasUsage) {
        usageState.usage = details.usage;
      }
      usageState.model = payload.model || payload.response?.model || usageState.model;

      // 累积响应文本用于 token 计数
      if (protocol === 'responses') {
        // 尝试多种可能的响应格式
        if (payload.response?.output) {
          const output = payload.response.output;
          if (Array.isArray(output)) {
            for (const item of output) {
              if (item.type === 'message' && Array.isArray(item.content)) {
                for (const content of item.content) {
                  if (content.type === 'text' && content.text) {
                    accumulatedText += content.text;
                  }
                }
              }
            }
          }
        } else if (payload.delta?.text) {
          // 可能是增量格式
          accumulatedText += payload.delta.text;
        } else if (payload.text) {
          // 可能是直接文本格式
          accumulatedText += payload.text;
        }
      } else if (protocol === 'chat_completions' && payload.choices) {
        for (const choice of payload.choices) {
          if (choice.delta?.content) {
            accumulatedText += choice.delta.content;
          }
        }
      }
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

  // 如果流式响应没有 usage，使用累积的文本计算
  if (!usageState.usage && accumulatedText) {
    const responseTokens = countStreamResponseTokens(accumulatedText, model);
    const requestTokens = protocol === 'responses'
      ? countResponsesRequestTokens(requestBody, model)
      : countChatRequestTokens(requestBody, model);

    usageState.usage = {
      prompt: requestTokens.prompt,
      completion: responseTokens.completion,
      total: requestTokens.prompt + responseTokens.completion,
    };

    // 调试日志
    console.log('[Token Counter] Calculated from accumulated text:', {
      model,
      protocol,
      accumulatedTextLength: accumulatedText.length,
      prompt: requestTokens.prompt,
      completion: responseTokens.completion,
      total: requestTokens.prompt + responseTokens.completion,
    });
  } else if (!usageState.usage && !accumulatedText) {
    // 没有累积到文本，可能是响应格式不匹配，使用请求估算
    if (requestBody) {
      const requestTokens = protocol === 'responses'
        ? countResponsesRequestTokens(requestBody, model)
        : countChatRequestTokens(requestBody, model);

      // 估算响应 token（假设响应长度约为请求的 2 倍）
      const estimatedCompletion = Math.ceil(requestTokens.prompt * 2);

      usageState.usage = {
        prompt: requestTokens.prompt,
        completion: estimatedCompletion,
        total: requestTokens.prompt + estimatedCompletion,
      };

      // 调试日志
      console.log('[Token Counter] Estimated (no accumulated text):', {
        model,
        protocol,
        prompt: requestTokens.prompt,
        estimatedCompletion,
        total: requestTokens.prompt + estimatedCompletion,
      });
    }
  }

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
    this.startedAt = Date.now();
    this.dashboardFile = path.resolve(process.cwd(), 'dashboard/index.html');
    this.packageManifest = loadPackageManifest();
    this.openClawNotificationConfig = {
      ...getOpenClawNotificationConfig(),
      ...(config.monitoring?.notifications?.openclaw || {}),
    };
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
    const configuredPort = this.config.monitoring.dashboard_port;
    const port = configuredPort === undefined || configuredPort === null
      ? 8080
      : Number(configuredPort);

    this.dashboardServer = http.createServer((req, res) => {
      this.handleDashboardRequest(req, res).catch((error) => {
        this.logger.error('dashboard request failed', {
          error: error.message,
          method: req.method || 'GET',
          path: req.url || '/',
        });
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

  buildRuntimeMeta() {
    let dashboardUpdatedAt = null;
    try {
      dashboardUpdatedAt = fs.statSync(this.dashboardFile).mtimeMs;
    } catch {
      // noop
    }

    return {
      app: this.packageManifest.name || 'llm-hub',
      version: this.packageManifest.version || 'unknown',
      build_revision: process.env.LLM_HUB_BUILD_REVISION || process.env.GIT_SHA || null,
      started_at: this.startedAt,
      uptime_ms: Date.now() - this.startedAt,
      config_path: this.config.configPath || null,
      dashboard_path: this.dashboardFile,
      dashboard_updated_at: dashboardUpdatedAt,
      database_type: this.config.database?.type || 'sqlite',
      listener_count: this.config.gateway?.ports?.length || 0,
      upstream_count: this.config.upstreams?.length || 0,
      monitoring_enabled: Boolean(this.config.monitoring?.enabled),
    };
  }

  async handleDashboardRequest(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (url.pathname === '/health') {
      json(res, 200, { ok: true, scope: 'dashboard' });
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const content = fs.readFileSync(this.dashboardFile, 'utf8');
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
      const successParam = url.searchParams.get('success');
      json(
        res,
        200,
        await this.database.getRequests({
          limit: Number(url.searchParams.get('limit') || 50),
          hours: url.searchParams.has('hours') ? Number(url.searchParams.get('hours')) : null,
          success:
            successParam === null
              ? null
              : successParam === 'true' || successParam === '1',
          app_name: url.searchParams.get('app_name') || null,
          upstream_id: url.searchParams.get('upstream_id') || null,
          route_mode: url.searchParams.get('route_mode') || null,
        })
      );
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
      json(res, 200, sanitizeConfigForDashboard(this.config));
      return;
    }
    if (url.pathname === '/api/meta') {
      json(res, 200, this.buildRuntimeMeta());
      return;
    }

    if (url.pathname === '/api/load-metrics') {
      const upstreams = this.upstreamManager.snapshot().map((upstream) => ({
        id: upstream.id,
        name: upstream.name,
        in_flight_requests: upstream.in_flight_requests,
        rolling_avg_latency_ms: upstream.rolling_avg_latency_ms,
        recent_success_rate: upstream.recent_success_rate,
        load_score: this.upstreamManager.computeLoadScore(upstream.id),
        circuit_state: upstream.circuit_state,
      }));
      json(res, 200, { upstreams, routing_mode: this.config.failover?.routing_mode || 'static' });
      return;
    }

    json(res, 404, { error: 'Not Found' });
  }

  buildRoutePlan(protocol, requestBody, listener) {
    const strategy = listener.routing_strategy || 'balanced';
    const routingMode = this.config.failover?.routing_mode || 'static';
    const dynamic = routingMode === 'dynamic';

    const upstreamIds = this.upstreamManager.getOrderedUpstreams(strategy, { dynamic });
    const passthrough = [];
    const transform = [];

    for (const upstreamId of upstreamIds) {
      const upstream = this.upstreamManager.getUpstream(upstreamId);
      if (!upstream) {
        continue;
      }
      if (!upstreamSupportsRequestedModel(requestBody?.model, upstream)) {
        continue;
      }
      if (supportsPassthrough(protocol, requestBody, upstream)) {
        passthrough.push({ mode: 'passthrough', upstream });
      } else if (supportsTransform(protocol, upstream, requestBody)) {
        transform.push({ mode: 'transform', upstream });
      }
    }

    // 对 passthrough 和 transform 池分别应用 P2C
    if (dynamic) {
      if (passthrough.length > 1) {
        const passthroughIds = passthrough.map((r) => r.upstream.id);
        const orderedIds = this.upstreamManager.selectUpstreamP2C(passthroughIds);
        passthrough.sort((a, b) => orderedIds.indexOf(a.upstream.id) - orderedIds.indexOf(b.upstream.id));
      }
      if (transform.length > 1) {
        const transformIds = transform.map((r) => r.upstream.id);
        const orderedIds = this.upstreamManager.selectUpstreamP2C(transformIds);
        transform.sort((a, b) => orderedIds.indexOf(a.upstream.id) - orderedIds.indexOf(b.upstream.id));
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

  async notifyFailover(details) {
    if (!this.config.monitoring?.notifications?.enabled) {
      return;
    }

    const payload = buildFailoverNotification(details);
    if (!payload) {
      return;
    }

    try {
      await sendOpenClawNotification(payload, this.openClawNotificationConfig, this.logger.child('notify'));
    } catch (error) {
      this.logger.warn('openclaw failover notification failed', {
        error: error.message,
        request_id: details.requestId,
        from_upstream_id: payload.metadata.from_upstream_id,
        to_upstream_id: payload.metadata.to_upstream_id,
      });
    }
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
      let requestStarted = false;

      try {
        // 标记请求开始
        this.upstreamManager.startRequest(route.upstream.id);
        requestStarted = true;

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

        // 标记请求成功结束
        this.upstreamManager.endRequest(route.upstream.id, latencyMs, true);
        this.upstreamManager.registerSuccess(route.upstream.id, latencyMs, result.statusCode);

        if (!result.usage) {
          this.logger.warn('upstream response missing usage', {
            app_name: listener.app_name,
            upstream_id: route.upstream.id,
            protocol,
            route_mode: route.mode,
          });
        }
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

        if (attempts.length) {
          await this.notifyFailover({
            listener,
            protocol,
            requestId,
            requestBody,
            attempts,
            route,
            timestamp: Date.now(),
          });
        }
        return;
      } catch (error) {
        const latencyMs = Date.now() - startedAt;

        // 标记请求失败结束（仅在请求已开始时）
        if (requestStarted) {
          this.upstreamManager.endRequest(route.upstream.id, latencyMs, false);
        }

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
    const mappedModel = requestBody?.model ? mapModel(requestBody.model, route.upstream) : null;
    const mappedRequestBody =
      requestBody?.model && mappedModel !== requestBody.model
        ? { ...requestBody, model: mappedModel }
        : requestBody;

    let upstreamBody = bodyBuffer;
    if (protocol === 'chat_completions' && mappedRequestBody) {
      const ensured = ensureChatStreamIncludesUsage(mappedRequestBody);
      if (ensured.injected || mappedRequestBody !== requestBody) {
        upstreamBody = Buffer.from(JSON.stringify(ensured.requestBody), 'utf8');
      }
    } else if (mappedRequestBody && mappedRequestBody !== requestBody) {
      upstreamBody = Buffer.from(JSON.stringify(mappedRequestBody), 'utf8');
    }
    const headers = {
      authorization: `Bearer ${route.upstream.api_key}`,
      'content-type': req.headers['content-type'] || 'application/json',
      accept: req.headers.accept || '*/*',
      'user-agent': req.headers['user-agent'] || 'llm-hub/0.1',
    };

    if (upstreamBody.length) {
      headers['content-length'] = String(upstreamBody.length);
    }

    const response = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body: upstreamBody.length ? upstreamBody : undefined,
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Upstream ${route.upstream.id} returned ${response.status}: ${text.slice(0, 200)}`);
    }

    const metadata = await streamFetchBody(response, res, protocol, requestBody, mappedModel || requestBody?.model);
    return {
      statusCode: response.status,
      usage: metadata.usage,
      model: metadata.model || mappedRequestBody?.model || null,
      warnings: [],
    };
  }

  async executeTransform({ req, res, requestBody, route, url }) {
    const { chatRequest, warnings } = transformResponsesRequestToChat(requestBody, route.upstream);
    const upstreamUrl = buildUpstreamUrl(route.upstream, 'chat_completions', url.search);
    const payload = Buffer.from(JSON.stringify(chatRequest), 'utf8');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), route.upstream.timeout_ms);

    console.log('[Transform] Starting request:', {
      upstream_id: route.upstream.id,
      stream: requestBody?.stream,
      model: chatRequest.model,
      url: upstreamUrl.toString(),
      requestBody: JSON.stringify(chatRequest).slice(0, 200),
    });

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

    console.log('[Transform] Response received:', {
      contentType,
      stream: requestBody?.stream,
    });

    if (requestBody?.stream === false) {
      console.log('[Transform] Branch: non-stream');
      let payloadJson;
      if (contentType.includes('text/event-stream')) {
        console.log('[Transform] Sub-branch: SSE to JSON');
        payloadJson = await collectChatCompletionFromSse(Readable.fromWeb(response.body));
      } else {
        console.log('[Transform] Sub-branch: JSON to JSON');
        const text = await response.text();
        payloadJson = JSON.parse(text);
      }
      const usage = payloadJson?.usage
        ? {
            prompt: payloadJson.usage.prompt_tokens || 0,
            completion: payloadJson.usage.completion_tokens || 0,
            total: payloadJson.usage.total_tokens || 0,
          }
        : null;

      console.log('[Transform] Usage check:', {
        hasUsageField: Boolean(payloadJson?.usage),
        usage,
        usageIsNull: usage === null,
      });

      // 如果没有 usage 或 usage 全为 0，使用 token 计数器
      let finalUsage = usage;
      const hasValidUsage = finalUsage && (finalUsage.prompt > 0 || finalUsage.completion > 0 || finalUsage.total > 0);

      if (!hasValidUsage) {
        const requestTokens = countResponsesRequestTokens(requestBody, chatRequest.model);
        const responseText = payloadJson?.choices?.[0]?.message?.content || '';
        const responseTokens = countStreamResponseTokens(responseText, chatRequest.model);

        finalUsage = {
          prompt: requestTokens.prompt,
          completion: responseTokens.completion,
          total: requestTokens.prompt + responseTokens.completion,
        };

        console.log('[Token Counter] Transform non-stream:', {
          model: chatRequest.model,
          responseTextLength: responseText.length,
          prompt: requestTokens.prompt,
          completion: responseTokens.completion,
          total: requestTokens.prompt + responseTokens.completion,
        });
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
        usage: finalUsage,
        model: transformed.model,
        warnings,
      };
    }

    if (!contentType.includes('text/event-stream')) {
      console.log('[Transform] Branch: JSON to SSE');
      const payloadJson = await response.json();
      const usage = payloadJson?.usage
        ? {
            prompt: payloadJson.usage.prompt_tokens || 0,
            completion: payloadJson.usage.completion_tokens || 0,
            total: payloadJson.usage.total_tokens || 0,
          }
        : null;

      // 如果没有 usage 或 usage 全为 0，使用 token 计数器
      let finalUsage = usage;
      const hasValidUsage = finalUsage && (finalUsage.prompt > 0 || finalUsage.completion > 0 || finalUsage.total > 0);

      if (!hasValidUsage) {
        const requestTokens = countResponsesRequestTokens(requestBody, chatRequest.model);
        const responseText = payloadJson?.choices?.[0]?.message?.content || '';
        const responseTokens = countStreamResponseTokens(responseText, chatRequest.model);

        finalUsage = {
          prompt: requestTokens.prompt,
          completion: responseTokens.completion,
          total: requestTokens.prompt + responseTokens.completion,
        };

        console.log('[Token Counter] Transform JSON-to-SSE:', {
          model: chatRequest.model,
          responseTextLength: responseText.length,
          prompt: requestTokens.prompt,
          completion: responseTokens.completion,
        });
      }

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
        usage: finalUsage,
        model: transformed.model,
        warnings,
      };
    }

    console.log('[Transform] Branch: SSE to SSE (streaming)');
    const nodeStream = Readable.fromWeb(response.body);
    nodeStream.statusCode = response.status;
    const result = await bridge.transformStreaming(nodeStream, res);

    console.log('[Transform Debug]', {
      hasUsage: Boolean(result.usage),
      usage: result.usage,
      hasAccumulatedText: Boolean(result.accumulatedText),
      accumulatedTextLength: result.accumulatedText?.length || 0,
    });

    let finalUsage = result.usage
      ? {
          prompt: result.usage.input_tokens || 0,
          completion: result.usage.output_tokens || 0,
          total: result.usage.total_tokens || 0,
        }
      : null;

    // 如果没有 usage，使用 token 计数器
    if (!finalUsage) {
      const requestTokens = countResponsesRequestTokens(requestBody, chatRequest.model);
      const responseText = result.accumulatedText || '';
      const responseTokens = countStreamResponseTokens(responseText, chatRequest.model);

      finalUsage = {
        prompt: requestTokens.prompt,
        completion: responseTokens.completion,
        total: requestTokens.prompt + responseTokens.completion,
      };

      console.log('[Token Counter] Transform streaming:', {
        model: chatRequest.model,
        responseTextLength: responseText.length,
        prompt: requestTokens.prompt,
        completion: responseTokens.completion,
      });
    }

    return {
      statusCode: 200,
      usage: finalUsage,
      model: result.model,
      warnings,
    };
  }
}
