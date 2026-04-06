import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';

function readSql(fileName) {
  return fs.readFileSync(path.resolve(process.cwd(), fileName), 'utf8');
}

function toNullableJson(value) {
  if (value === undefined || value === null) {
    return null;
  }
  return JSON.stringify(value);
}

function selectTrendBucketMs(hours) {
  const numericHours = Number(hours || 24);
  if (numericHours <= 1) {
    return 5 * 60 * 1000;
  }
  if (numericHours <= 24) {
    return 60 * 60 * 1000;
  }
  return 24 * 60 * 60 * 1000;
}

function normalizeTrendRow(row) {
  return {
    bucket_start: Number(row.bucket_start),
    total_requests: Number(row.total_requests || 0),
    successful_requests: Number(row.successful_requests || 0),
    failed_requests: Number(row.failed_requests || 0),
    tokens_total: Number(row.tokens_total || 0),
    total_cost_usd: Number(row.total_cost_usd || 0),
  };
}

function fillTrendBuckets(rows, since, until, bucketMs) {
  const alignedStart = Math.floor(Number(since) / bucketMs) * bucketMs;
  const alignedEnd = Math.floor(Number(until) / bucketMs) * bucketMs;
  const byBucket = new Map(rows.map((row) => {
    const normalized = normalizeTrendRow(row);
    return [normalized.bucket_start, normalized];
  }));
  const result = [];

  for (let bucket = alignedStart; bucket <= alignedEnd; bucket += bucketMs) {
    result.push(
      byBucket.get(bucket) || {
        bucket_start: bucket,
        total_requests: 0,
        successful_requests: 0,
        failed_requests: 0,
        tokens_total: 0,
        total_cost_usd: 0,
      }
    );
  }

  return result;
}

function normalizePositiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const integer = Math.trunc(numeric);
  if (integer < min) {
    return fallback;
  }
  return Math.min(integer, max);
}

function normalizeNullableHours(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}

function normalizeNullableString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export class DatabaseAdapter {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.requestQueue = [];
    this.stateQueue = new Map();
    this.flushScheduled = false;
    this.db = null;
    this.pool = null;
  }

  async init() {
    if (this.config.type === 'postgres') {
      await this.initPostgres();
      return;
    }
    await this.initSqlite();
  }

  async initSqlite() {
    const dbPath = path.resolve(process.cwd(), this.config.path || './data/llmhub.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(readSql('db/schema.sql'));
    this.insertRequestStatement = this.db.prepare(`
      INSERT INTO requests (
        timestamp, request_id, upstream_id, model, app_name, app_port, request_protocol, route_mode,
        success, latency_ms, status_code, error_type, error_message, tokens_prompt, tokens_completion,
        tokens_total, cost_usd, metadata_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);
    this.insertStateStatement = this.db.prepare(`
      INSERT INTO upstream_states (
        upstream_id, circuit_state, consecutive_failures, cooldown_until, last_failure_at, last_success_at,
        average_latency_ms, success_count, failure_count, last_error, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(upstream_id) DO UPDATE SET
        circuit_state = excluded.circuit_state,
        consecutive_failures = excluded.consecutive_failures,
        cooldown_until = excluded.cooldown_until,
        last_failure_at = excluded.last_failure_at,
        last_success_at = excluded.last_success_at,
        average_latency_ms = excluded.average_latency_ms,
        success_count = excluded.success_count,
        failure_count = excluded.failure_count,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `);
  }

  async initPostgres() {
    if (!this.config.url) {
      throw new Error('database.url is required when database.type=postgres');
    }
    this.pool = new Pool({ connectionString: this.config.url });
    await this.pool.query(readSql('db/postgres_schema.sql'));
  }

  recordRequest(record) {
    this.requestQueue.push(record);
    this.scheduleFlush();
  }

  recordUpstreamState(state) {
    this.stateQueue.set(state.upstream_id, { ...state });
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushScheduled) {
      return;
    }
    this.flushScheduled = true;
    setImmediate(() => {
      this.flush().catch((error) => {
        this.logger?.error('database flush failed', { error: error.message });
      });
    });
  }

  async flush() {
    this.flushScheduled = false;
    const requests = this.requestQueue.splice(0, this.requestQueue.length);
    const states = [...this.stateQueue.values()];
    this.stateQueue.clear();

    if (this.pool) {
      await this.flushPostgres(requests, states);
      return;
    }
    this.flushSqlite(requests, states);
  }

  flushSqlite(requests, states) {
    try {
      this.db.exec('BEGIN');
      for (const record of requests) {
        this.insertRequestStatement.run(
          record.timestamp,
          record.request_id,
          record.upstream_id || null,
          record.model || null,
          record.app_name,
          record.app_port,
          record.request_protocol,
          record.route_mode,
          record.success ? 1 : 0,
          record.latency_ms || null,
          record.status_code || null,
          record.error_type || null,
          record.error_message || null,
          record.tokens_prompt || 0,
          record.tokens_completion || 0,
          record.tokens_total || 0,
          record.cost_usd || 0,
          toNullableJson(record.metadata)
        );
      }
      for (const state of states) {
        this.insertStateStatement.run(
          state.upstream_id,
          state.circuit_state,
          state.consecutive_failures || 0,
          state.cooldown_until || null,
          state.last_failure_at || null,
          state.last_success_at || null,
          state.average_latency_ms || 0,
          state.success_count || 0,
          state.failure_count || 0,
          state.last_error || null,
          state.updated_at
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async flushPostgres(requests, states) {
    if (!requests.length && !states.length) {
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const record of requests) {
        await client.query(
          `
            INSERT INTO requests (
              timestamp, request_id, upstream_id, model, app_name, app_port, request_protocol, route_mode,
              success, latency_ms, status_code, error_type, error_message, tokens_prompt, tokens_completion,
              tokens_total, cost_usd, metadata_json
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8,
              $9, $10, $11, $12, $13, $14, $15,
              $16, $17, $18::jsonb
            )
          `,
          [
            record.timestamp,
            record.request_id,
            record.upstream_id || null,
            record.model || null,
            record.app_name,
            record.app_port,
            record.request_protocol,
            record.route_mode,
            record.success,
            record.latency_ms || null,
            record.status_code || null,
            record.error_type || null,
            record.error_message || null,
            record.tokens_prompt || 0,
            record.tokens_completion || 0,
            record.tokens_total || 0,
            record.cost_usd || 0,
            toNullableJson(record.metadata),
          ]
        );
      }
      for (const state of states) {
        await client.query(
          `
            INSERT INTO upstream_states (
              upstream_id, circuit_state, consecutive_failures, cooldown_until, last_failure_at, last_success_at,
              average_latency_ms, success_count, failure_count, last_error, updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
            )
            ON CONFLICT (upstream_id) DO UPDATE SET
              circuit_state = EXCLUDED.circuit_state,
              consecutive_failures = EXCLUDED.consecutive_failures,
              cooldown_until = EXCLUDED.cooldown_until,
              last_failure_at = EXCLUDED.last_failure_at,
              last_success_at = EXCLUDED.last_success_at,
              average_latency_ms = EXCLUDED.average_latency_ms,
              success_count = EXCLUDED.success_count,
              failure_count = EXCLUDED.failure_count,
              last_error = EXCLUDED.last_error,
              updated_at = EXCLUDED.updated_at
          `,
          [
            state.upstream_id,
            state.circuit_state,
            state.consecutive_failures || 0,
            state.cooldown_until || null,
            state.last_failure_at || null,
            state.last_success_at || null,
            state.average_latency_ms || 0,
            state.success_count || 0,
            state.failure_count || 0,
            state.last_error || null,
            state.updated_at,
          ]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getRequests({
    limit = 50,
    hours = null,
    success = null,
    app_name = null,
    upstream_id = null,
    route_mode = null,
  } = {}) {
    await this.flush();
    const effectiveLimit = normalizePositiveInteger(limit, 50, { min: 1, max: 500 });
    const normalizedHours = normalizeNullableHours(hours);
    const normalizedAppName = normalizeNullableString(app_name);
    const normalizedUpstreamId = normalizeNullableString(upstream_id);
    const normalizedRouteMode = normalizeNullableString(route_mode);
    const normalizedSuccess = success === null || success === undefined ? null : Boolean(success);

    if (this.pool) {
      const filters = [];
      const values = [];

      if (normalizedHours !== null) {
        filters.push(`timestamp >= $${values.length + 1}`);
        values.push(Date.now() - normalizedHours * 60 * 60 * 1000);
      }
      if (normalizedSuccess !== null) {
        filters.push(`success = $${values.length + 1}`);
        values.push(normalizedSuccess);
      }
      if (normalizedAppName) {
        filters.push(`app_name = $${values.length + 1}`);
        values.push(normalizedAppName);
      }
      if (normalizedUpstreamId) {
        filters.push(`upstream_id = $${values.length + 1}`);
        values.push(normalizedUpstreamId);
      }
      if (normalizedRouteMode) {
        filters.push(`route_mode = $${values.length + 1}`);
        values.push(normalizedRouteMode);
      }

      const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      values.push(effectiveLimit);
      const result = await this.pool.query(
        `
          SELECT * FROM requests
          ${whereClause}
          ORDER BY timestamp DESC
          LIMIT $${values.length}
        `,
        values
      );
      return result.rows;
    }

    const filters = [];
    const values = [];

    if (normalizedHours !== null) {
      filters.push('timestamp >= ?');
      values.push(Date.now() - normalizedHours * 60 * 60 * 1000);
    }
    if (normalizedSuccess !== null) {
      filters.push('success = ?');
      values.push(normalizedSuccess ? 1 : 0);
    }
    if (normalizedAppName) {
      filters.push('app_name = ?');
      values.push(normalizedAppName);
    }
    if (normalizedUpstreamId) {
      filters.push('upstream_id = ?');
      values.push(normalizedUpstreamId);
    }
    if (normalizedRouteMode) {
      filters.push('route_mode = ?');
      values.push(normalizedRouteMode);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

    const sql = `
      SELECT * FROM requests
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ?
    `;
    values.push(effectiveLimit);
    return this.db.prepare(sql).all(...values);
  }

  async getRecentRequests(limit = 50) {
    return this.getRequests({ limit });
  }

  async getSummary(hours = 24) {
    await this.flush();
    const now = Date.now();
    const since = now - hours * 60 * 60 * 1000;
    const bucketMs = selectTrendBucketMs(hours);

    if (this.pool) {
      const [summary, apps, upstreams, trend] = await Promise.all([
        this.pool.query(
          `
            SELECT
              COUNT(*)::int AS total_requests,
              COALESCE(SUM(CASE WHEN success THEN 1 ELSE 0 END), 0)::int AS successful_requests,
              COALESCE(SUM(CASE WHEN success THEN 0 ELSE 1 END), 0)::int AS failed_requests,
              COALESCE(AVG(latency_ms), 0) AS average_latency_ms,
              COALESCE(SUM(tokens_prompt), 0)::int AS tokens_prompt,
              COALESCE(SUM(tokens_completion), 0)::int AS tokens_completion,
              COALESCE(SUM(tokens_total), 0)::int AS tokens_total,
              COALESCE(SUM(cost_usd), 0) AS total_cost_usd
            FROM requests
            WHERE timestamp >= $1
          `,
          [since]
        ),
        this.pool.query(
          `
            SELECT
              app_name,
              COUNT(*)::int AS total_requests,
              COALESCE(SUM(tokens_total), 0)::int AS tokens_total,
              COALESCE(SUM(cost_usd), 0) AS total_cost_usd
            FROM requests
            WHERE timestamp >= $1
            GROUP BY app_name
            ORDER BY total_requests DESC
          `,
          [since]
        ),
        this.pool.query(
          `
            SELECT
              upstream_id,
              COUNT(*)::int AS total_requests,
              COALESCE(SUM(CASE WHEN success THEN 1 ELSE 0 END), 0)::int AS successful_requests,
              COALESCE(SUM(CASE WHEN success THEN 0 ELSE 1 END), 0)::int AS failed_requests,
              COALESCE(SUM(tokens_total), 0)::int AS tokens_total,
              COALESCE(SUM(cost_usd), 0) AS total_cost_usd
            FROM requests
            WHERE timestamp >= $1
              AND upstream_id IS NOT NULL
            GROUP BY upstream_id
            ORDER BY total_cost_usd DESC, total_requests DESC, upstream_id ASC
          `,
          [since]
        ),
        this.pool.query(
          `
            SELECT
              (FLOOR(timestamp::numeric / $2::numeric)::bigint * $2::bigint) AS bucket_start,
              COUNT(*)::int AS total_requests,
              COALESCE(SUM(CASE WHEN success THEN 1 ELSE 0 END), 0)::int AS successful_requests,
              COALESCE(SUM(CASE WHEN success THEN 0 ELSE 1 END), 0)::int AS failed_requests,
              COALESCE(SUM(tokens_total), 0)::int AS tokens_total,
              COALESCE(SUM(cost_usd), 0) AS total_cost_usd
            FROM requests
            WHERE timestamp >= $1
            GROUP BY bucket_start
            ORDER BY bucket_start ASC
          `,
          [since, bucketMs]
        ),
      ]);
      return {
        time_window_hours: hours,
        bucket_ms: bucketMs,
        ...(summary.rows[0] || {}),
        apps: apps.rows,
        upstreams: upstreams.rows,
        trend: fillTrendBuckets(trend.rows, since, now, bucketMs),
      };
    }

    const summaryRow = this.db.prepare(`
      SELECT
        COUNT(*) AS total_requests,
        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) AS successful_requests,
        COALESCE(SUM(CASE WHEN success = 1 THEN 0 ELSE 1 END), 0) AS failed_requests,
        COALESCE(AVG(latency_ms), 0) AS average_latency_ms,
        COALESCE(SUM(tokens_prompt), 0) AS tokens_prompt,
        COALESCE(SUM(tokens_completion), 0) AS tokens_completion,
        COALESCE(SUM(tokens_total), 0) AS tokens_total,
        COALESCE(SUM(cost_usd), 0) AS total_cost_usd
      FROM requests
      WHERE timestamp >= ?
    `).get(since);

    const apps = this.db.prepare(`
      SELECT
        app_name,
        COUNT(*) AS total_requests,
        COALESCE(SUM(tokens_total), 0) AS tokens_total,
        COALESCE(SUM(cost_usd), 0) AS total_cost_usd
      FROM requests
      WHERE timestamp >= ?
      GROUP BY app_name
      ORDER BY total_requests DESC
    `).all(since);

    const upstreams = this.db.prepare(`
      SELECT
        upstream_id,
        COUNT(*) AS total_requests,
        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) AS successful_requests,
        COALESCE(SUM(CASE WHEN success = 1 THEN 0 ELSE 1 END), 0) AS failed_requests,
        COALESCE(SUM(tokens_total), 0) AS tokens_total,
        COALESCE(SUM(cost_usd), 0) AS total_cost_usd
      FROM requests
      WHERE timestamp >= ?
        AND upstream_id IS NOT NULL
      GROUP BY upstream_id
      ORDER BY total_cost_usd DESC, total_requests DESC, upstream_id ASC
    `).all(since);

    const trendRows = this.db.prepare(`
      SELECT
        CAST(timestamp / ? AS INTEGER) * ? AS bucket_start,
        COUNT(*) AS total_requests,
        COALESCE(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END), 0) AS successful_requests,
        COALESCE(SUM(CASE WHEN success = 1 THEN 0 ELSE 1 END), 0) AS failed_requests,
        COALESCE(SUM(tokens_total), 0) AS tokens_total,
        COALESCE(SUM(cost_usd), 0) AS total_cost_usd
      FROM requests
      WHERE timestamp >= ?
      GROUP BY bucket_start
      ORDER BY bucket_start ASC
    `).all(bucketMs, bucketMs, since);

    return {
      time_window_hours: hours,
      bucket_ms: bucketMs,
      ...summaryRow,
      apps,
      upstreams,
      trend: fillTrendBuckets(trendRows, since, now, bucketMs),
    };
  }

  async getUpstreamStates() {
    await this.flush();
    if (this.pool) {
      const result = await this.pool.query('SELECT * FROM upstream_states ORDER BY upstream_id ASC');
      return result.rows;
    }
    return this.db.prepare('SELECT * FROM upstream_states ORDER BY upstream_id ASC').all();
  }

  async close() {
    await this.flush();
    if (this.pool) {
      await this.pool.end();
    }
    if (this.db) {
      this.db.close();
    }
  }
}
