#!/usr/bin/env node

/**
 * Simple Passthrough Proxy for quan2go /responses API
 *
 * This is a minimal proxy that forwards requests from Codex CLI to quan2go
 * without any transformation. It's designed to validate that quan2go's native
 * /responses API support works correctly.
 *
 * Usage:
 *   1. Set environment variable: export GPT_KEY_B="your-api-key"
 *   2. Run: node simple-passthrough-proxy.mjs
 *   3. Configure Codex CLI to use: http://127.0.0.1:4105
 *
 * Environment Variables:
 *   - GPT_KEY_B: API key for quan2go (required)
 *
 * Features:
 *   - Zero transformation (complete passthrough)
 *   - Streaming support (SSE)
 *   - Error handling (network, timeout, upstream errors)
 *   - Graceful shutdown (SIGINT/SIGTERM)
 */

import http from 'http';
import https from 'https';
import { loadEnvFiles } from './lib/env.mjs';

loadEnvFiles();

// Configuration
const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = 4105;
const QUAN2GO_ORIGIN = 'capi.quan2go.com';
const RESPONSES_FULL_PATH = '/openai/responses';
const REQUEST_TIMEOUT = 120000; // 2 minutes

// Validate environment
const API_KEY = process.env.GPT_KEY_B;
if (!API_KEY) {
  console.error('[ERROR] Environment variable GPT_KEY_B is not set');
  process.exit(1);
}

// Logging utilities
function log(level, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  console.log(`[${timestamp}] [${level}] ${message}${metaStr}`);
}

// Create HTTP server
const server = http.createServer((req, res) => {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const startTime = Date.now();

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, listen: `${LISTEN_HOST}:${LISTEN_PORT}` }));
    return;
  }

  log('INFO', 'Request received', {
    requestId,
    method: req.method,
    url: req.url,
    headers: {
      'content-type': req.headers['content-type'],
      'user-agent': req.headers['user-agent']
    }
  });

  // Only handle /responses endpoint
  if (!req.url.startsWith('/responses') && !req.url.startsWith('/v1/responses')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found', message: 'Only /responses endpoint is supported' }));
    log('WARN', 'Request to unsupported endpoint', { requestId, url: req.url });
    return;
  }

  // Only handle POST method
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method Not Allowed', message: 'Only POST method is supported' }));
    log('WARN', 'Unsupported HTTP method', { requestId, method: req.method });
    return;
  }

  // Build upstream request path (preserve query string)
  const normalizedPath = req.url.startsWith('/v1/responses') ? '/v1/responses' : '/responses';
  const queryString = req.url.substring(normalizedPath.length);
  const upstreamPath = RESPONSES_FULL_PATH + queryString;

  log('INFO', 'Forwarding to upstream', {
    requestId,
    upstream: `https://${QUAN2GO_ORIGIN}${upstreamPath}`
  });

  // Prepare upstream request options
  const upstreamOptions = {
    hostname: QUAN2GO_ORIGIN,
    port: 443,
    path: upstreamPath,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': req.headers['content-type'] || 'application/json',
      'User-Agent': req.headers['user-agent'] || 'simple-passthrough-proxy/1.0',
      'Accept': req.headers['accept'] || '*/*'
    },
    timeout: REQUEST_TIMEOUT
  };

  // Forward Content-Length if present
  if (req.headers['content-length']) {
    upstreamOptions.headers['Content-Length'] = req.headers['content-length'];
  }

  // Create upstream request
  const upstreamReq = https.request(upstreamOptions, (upstreamRes) => {
    const statusCode = upstreamRes.statusCode;

    log('INFO', 'Upstream response received', {
      requestId,
      statusCode,
      headers: {
        'content-type': upstreamRes.headers['content-type'],
        'transfer-encoding': upstreamRes.headers['transfer-encoding']
      }
    });

    // Passthrough status code
    res.writeHead(statusCode, upstreamRes.headers);

    // Passthrough response body using pipe (zero buffering)
    upstreamRes.pipe(res);

    // Handle upstream response completion
    upstreamRes.on('end', () => {
      const duration = Date.now() - startTime;
      log('INFO', 'Request completed', {
        requestId,
        statusCode,
        duration: `${duration}ms`
      });
    });

    // Handle upstream response errors
    upstreamRes.on('error', (error) => {
      log('ERROR', 'Upstream response error', {
        requestId,
        error: error.message
      });

      // If headers not sent yet, send error response
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'Bad Gateway',
          message: 'Error reading upstream response'
        }));
      } else {
        // If streaming already started, just end the response
        res.end();
      }
    });
  });

  // Handle upstream request errors
  upstreamReq.on('error', (error) => {
    log('ERROR', 'Upstream request error', {
      requestId,
      error: error.message,
      code: error.code
    });

    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Bad Gateway',
        message: 'Failed to connect to upstream server'
      }));
    }
  });

  // Handle upstream request timeout
  upstreamReq.on('timeout', () => {
    log('ERROR', 'Upstream request timeout', { requestId });
    upstreamReq.destroy();

    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Gateway Timeout',
        message: 'Upstream server did not respond in time'
      }));
    }
  });

  // Forward request body using pipe (zero buffering)
  req.pipe(upstreamReq);

  // Handle client request errors
  req.on('error', (error) => {
    log('ERROR', 'Client request error', {
      requestId,
      error: error.message
    });
    upstreamReq.destroy();
  });
});

// Handle server errors
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    log('ERROR', `Port ${LISTEN_PORT} is already in use`);
  } else {
    log('ERROR', 'Server error', { error: error.message });
  }
  process.exit(1);
});

// Start server
server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log('INFO', `Proxy server started`, {
    listen: `${LISTEN_HOST}:${LISTEN_PORT}`,
    upstream: `https://${QUAN2GO_ORIGIN}${RESPONSES_FULL_PATH}`,
    pid: process.pid
  });
});

// Graceful shutdown
function shutdown(signal) {
  log('INFO', `Received ${signal}, shutting down gracefully...`);

  server.close(() => {
    log('INFO', 'Server closed, exiting');
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    log('WARN', 'Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
