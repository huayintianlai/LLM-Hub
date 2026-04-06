import fs from 'fs';
import http from 'http';
import https from 'https';
import { URL } from 'url';

const envPath = new URL('./.env', import.meta.url);
const envFile = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const env = Object.fromEntries(
  envFile
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    })
);

const configPath = process.env.GATEWAY_CONFIG
  ? new URL(process.env.GATEWAY_CONFIG, 'file://')
  : new URL('./gateway.config.json', import.meta.url);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const startedAt = Date.now();
const upstreamState = new Map();

function getEnvValue(name) {
  return process.env[name] || env[name] || '';
}

function now() {
  return Date.now();
}

function getUpstreamState(id) {
  if (!upstreamState.has(id)) {
    upstreamState.set(id, {
      id,
      failureCount: 0,
      successCount: 0,
      cooldownUntil: 0,
      lastError: null,
      lastStatusCode: null,
      lastFailureAt: null,
      lastSuccessAt: null,
    });
  }
  return upstreamState.get(id);
}

function log(scope, message, extra) {
  const prefix = `[${new Date().toISOString()}] [${scope}] ${message}`;
  if (extra === undefined) {
    console.error(prefix);
    return;
  }
  console.error(prefix, extra);
}

function normalizeSearch(search = '') {
  return search ? (search.startsWith('?') ? search : `?${search}`) : '';
}

function extractBearerToken(headers) {
  const raw = String(headers.authorization || '');
  if (!raw.toLowerCase().startsWith('bearer ')) {
    return '';
  }
  return raw.slice(7).trim();
}

function getAcceptedTokens(listener) {
  return (listener.acceptedTokenEnvs || [])
    .map((name) => getEnvValue(name))
    .filter(Boolean);
}

function isAuthorized(listener, headers) {
  if (!listener.requireBearer) {
    return true;
  }
  const bearer = extractBearerToken(headers);
  if (!bearer) {
    return false;
  }
  const accepted = getAcceptedTokens(listener);
  if (!accepted.length) {
    return true;
  }
  return accepted.includes(bearer);
}

function writeJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    connection: 'close',
  });
  res.end(body);
}

function sanitizeHeaders(headers) {
  const next = { ...headers };
  delete next.host;
  delete next.connection;
  delete next['content-length'];
  delete next['accept-encoding'];
  return next;
}

function sanitizeResponseHeaders(headers) {
  const next = { ...headers };
  delete next['content-length'];
  delete next['transfer-encoding'];
  delete next.connection;
  return next;
}

function buildPath(adapterName, pathname, search) {
  if (adapterName !== 'openai_passthrough') {
    return `${pathname}${normalizeSearch(search)}`;
  }
  if (pathname.startsWith('/v1/')) {
    return `${pathname}${normalizeSearch(search)}`;
  }
  if (
    pathname === '/models' || pathname.startsWith('/models/') ||
    pathname === '/chat/completions' || pathname.startsWith('/chat/completions/') ||
    pathname === '/embeddings' || pathname.startsWith('/embeddings/') ||
    pathname === '/responses' || pathname.startsWith('/responses/')
  ) {
    return `/v1${pathname}${normalizeSearch(search)}`;
  }
  return `${pathname}${normalizeSearch(search)}`;
}

function buildUpstreamUrl(baseUrl, adapterName, pathname, search) {
  const target = new URL(baseUrl);
  const upstreamPath = buildPath(adapterName, pathname, search);
  const basePath = target.pathname.endsWith('/') ? target.pathname.slice(0, -1) : target.pathname;
  const fullPath = basePath && upstreamPath.startsWith('/v1/') && basePath.endsWith('/v1')
    ? `${basePath}${upstreamPath.slice(3)}`
    : `${basePath}${upstreamPath}`;
  return {
    target,
    fullPath,
    url: `${target.protocol}//${target.hostname}${target.port ? `:${target.port}` : ''}${fullPath}`,
  };
}

function shouldFailover(statusCode, routeGroup) {
  return (routeGroup.failStatusCodes || []).includes(statusCode || 0);
}

function markSuccess(upstreamId, statusCode) {
  const state = getUpstreamState(upstreamId);
  state.successCount += 1;
  state.lastStatusCode = statusCode || null;
  state.lastSuccessAt = new Date().toISOString();
  state.lastError = null;
  state.cooldownUntil = 0;
}

function markFailure(upstreamId, routeGroup, reason, statusCode) {
  const state = getUpstreamState(upstreamId);
  state.failureCount += 1;
  state.lastError = reason;
  state.lastStatusCode = statusCode || null;
  state.lastFailureAt = new Date().toISOString();
  state.cooldownUntil = now() + (routeGroup.cooldownMs || 0);
}

function getRouteGroup(name) {
  return config.routeGroups[name] || { upstreams: [], cooldownMs: 0, failStatusCodes: [] };
}

function getOrderedUpstreams(routeGroupName) {
  const group = getRouteGroup(routeGroupName);
  const active = [];
  const cooling = [];
  for (const upstreamId of group.upstreams || []) {
    const state = getUpstreamState(upstreamId);
    const item = { upstreamId, state };
    if (state.cooldownUntil > now()) {
      cooling.push(item);
    } else {
      active.push(item);
    }
  }
  return [...active, ...cooling].map((item) => item.upstreamId);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : null));
    req.on('error', reject);
  });
}

function collectErrorBody(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      if (size < 32768) {
        chunks.push(chunk);
        size += chunk.length;
      }
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () => resolve(''));
  });
}

async function proxyAttempt({ listener, requestUrl, req, res, body, upstreamId }) {
  const upstream = config.upstreams[upstreamId];
  if (!upstream) {
    return { ok: false, upstreamId, reason: 'missing upstream config' };
  }
  const authToken = getEnvValue(upstream.authEnv);
  if (!authToken) {
    return { ok: false, upstreamId, reason: `missing auth env ${upstream.authEnv}` };
  }

  const headers = sanitizeHeaders(req.headers);
  headers.authorization = `Bearer ${authToken}`;
  if (body) {
    headers['content-length'] = String(body.length);
  }

  const targetMeta = buildUpstreamUrl(upstream.baseUrl, upstream.adapter, requestUrl.pathname, requestUrl.search);
  const httpModule = targetMeta.target.protocol === 'https:' ? https : http;
  const scope = `${listener.name}:${upstreamId}`;
  log(scope, `proxy ${req.method} ${requestUrl.pathname} -> ${targetMeta.url}`);

  return new Promise((resolve) => {
    const upstreamReq = httpModule.request(
      {
        hostname: targetMeta.target.hostname,
        port: targetMeta.target.port || (targetMeta.target.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: targetMeta.fullPath,
        headers,
      },
      async (upstreamRes) => {
        const routeGroup = getRouteGroup(listener.routeGroup);
        if (shouldFailover(upstreamRes.statusCode || 0, routeGroup)) {
          const errorBody = await collectErrorBody(upstreamRes);
          resolve({
            ok: false,
            upstreamId,
            statusCode: upstreamRes.statusCode || 0,
            reason: errorBody || `status ${upstreamRes.statusCode || 0}`,
          });
          return;
        }

        const responseHeaders = sanitizeResponseHeaders(upstreamRes.headers);
        responseHeaders['x-local-gateway-listener'] = listener.name;
        responseHeaders['x-local-gateway-upstream'] = upstreamId;
        res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
        upstreamRes.pipe(res);
        upstreamRes.on('end', () => resolve({ ok: true, upstreamId, statusCode: upstreamRes.statusCode || 200 }));
        upstreamRes.on('error', (error) => {
          log(scope, 'upstream stream error', String(error));
          if (!res.writableEnded) {
            res.end();
          }
          resolve({ ok: true, upstreamId, statusCode: upstreamRes.statusCode || 200 });
        });
      }
    );

    upstreamReq.setTimeout(upstream.timeoutMs || 60000, () => {
      upstreamReq.destroy(new Error(`timeout after ${upstream.timeoutMs || 60000}ms`));
    });

    upstreamReq.on('error', (error) => {
      resolve({ ok: false, upstreamId, statusCode: 502, reason: String(error) });
    });

    if (body) {
      upstreamReq.write(body);
    }
    upstreamReq.end();
  });
}

function getStatusPayload(listenerName = null) {
  const listeners = (config.listeners || [])
    .filter((listener) => !listenerName || listener.name === listenerName)
    .map((listener) => ({
      name: listener.name,
      bind: listener.bind,
      port: listener.port,
      clientProfile: listener.clientProfile,
      routeGroup: listener.routeGroup,
      acceptedTokenEnvs: listener.acceptedTokenEnvs || [],
      upstreams: getOrderedUpstreams(listener.routeGroup).map((upstreamId) => {
        const upstream = config.upstreams[upstreamId];
        const state = getUpstreamState(upstreamId);
        return {
          id: upstreamId,
          adapter: upstream?.adapter || null,
          baseUrl: upstream?.baseUrl || null,
          authEnv: upstream?.authEnv || null,
          cooldownUntil: state.cooldownUntil ? new Date(state.cooldownUntil).toISOString() : null,
          inCooldown: state.cooldownUntil > now(),
          lastStatusCode: state.lastStatusCode,
          lastError: state.lastError,
          lastFailureAt: state.lastFailureAt,
          lastSuccessAt: state.lastSuccessAt,
          failureCount: state.failureCount,
          successCount: state.successCount,
        };
      }),
    }));

  return {
    ok: true,
    uptimeMs: now() - startedAt,
    listeners,
  };
}

async function handleRequest(listener, req, res) {
  const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');

  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    writeJson(res, 200, {
      ok: true,
      listener: listener.name,
      clientProfile: listener.clientProfile,
      routeGroup: listener.routeGroup,
      uptimeMs: now() - startedAt,
    });
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/status') {
    writeJson(res, 200, getStatusPayload(listener.name));
    return;
  }

  if (!isAuthorized(listener, req.headers)) {
    writeJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (error) {
    writeJson(res, 400, { error: String(error) });
    return;
  }

  const routeGroup = getRouteGroup(listener.routeGroup);
  const attempts = [];
  for (const upstreamId of getOrderedUpstreams(listener.routeGroup)) {
    const result = await proxyAttempt({ listener, requestUrl, req, res, body, upstreamId });
    attempts.push({ upstreamId, ok: result.ok, statusCode: result.statusCode || null, reason: result.reason || null });
    if (result.ok) {
      markSuccess(upstreamId, result.statusCode);
      return;
    }
    markFailure(upstreamId, routeGroup, result.reason || 'unknown error', result.statusCode);
  }

  const payload = {
    error: 'No upstream available',
    listener: listener.name,
    routeGroup: listener.routeGroup,
    attempts,
  };
  writeJson(res, 502, payload);
}

function startListener(listener) {
  const server = http.createServer((req, res) => {
    handleRequest(listener, req, res).catch((error) => {
      log(listener.name, 'handler error', String(error));
      if (!res.headersSent) {
        writeJson(res, 500, { error: String(error) });
        return;
      }
      res.end();
    });
  });

  server.listen(listener.port, listener.bind, () => {
    log(listener.name, `listening on http://${listener.bind}:${listener.port}`);
  });

  return server;
}

for (const listener of config.listeners || []) {
  startListener(listener);
}
