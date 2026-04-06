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

  async getRecentRequests(limit = 50) {
    await this.flush();
    if (this.pool) {
      const result = await this.pool.query(
        `
          SELECT * FROM requests
          ORDER BY timestamp DESC
          LIMIT $1
        `,
        [limit]
      );
      return result.rows;
    }
    return this.db
      .prepare('SELECT * FROM requests ORDER BY timestamp DESC LIMIT ?')
      .all(limit);
  }

  async getSummary(hours = 24) {
    await this.flush();
    const since = Date.now() - hours * 60 * 60 * 1000;

    if (this.pool) {
      const [summary, apps] = await Promise.all([
        this.pool.query(
          `
            SELECT
              COUNT(*)::int AS total_requests,
              SUM(CASE WHEN success THEN 1 ELSE 0 END)::int AS successful_requests,
              COALESCE(AVG(latency_ms), 0) AS average_latency_ms,
              COALESCE(SUM(cost_usd), 0) AS total_cost_usd
            FROM requests
            WHERE timestamp >= $1
          `,
          [since]
        ),
        this.pool.query(
          `
            SELECT app_name, COUNT(*)::int AS total_requests, COALESCE(SUM(cost_usd), 0) AS total_cost_usd
            FROM requests
            WHERE timestamp >= $1
            GROUP BY app_name
            ORDER BY total_requests DESC
          `,
          [since]
        ),
      ]);
      return {
        time_window_hours: hours,
        ...(summary.rows[0] || {}),
        apps: apps.rows,
      };
    }

    const summaryRow = this.db.prepare(`
      SELECT
        COUNT(*) AS total_requests,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successful_requests,
        COALESCE(AVG(latency_ms), 0) AS average_latency_ms,
        COALESCE(SUM(cost_usd), 0) AS total_cost_usd
      FROM requests
      WHERE timestamp >= ?
    `).get(since);

    const apps = this.db.prepare(`
      SELECT app_name, COUNT(*) AS total_requests, COALESCE(SUM(cost_usd), 0) AS total_cost_usd
      FROM requests
      WHERE timestamp >= ?
      GROUP BY app_name
      ORDER BY total_requests DESC
    `).all(since);

    return {
      time_window_hours: hours,
      ...summaryRow,
      apps,
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
