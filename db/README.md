# Database guide

`LLM-Hub` persists telemetry and routing state in a single database. The default is SQLite for Phase 1, but the schema and tools are compatible with PostgreSQL as well.

## Schema

- `requests`: stores every proxied request with metadata such as latency, upstream, app port, and token/cost estimates.
- `upstream_states`: mirrors the in-memory circuit breaker state for each upstream.
- `migrations`: records which manual migration files have been applied.

The base schema lives in `db/schema.sql`, and the initial tables are created automatically when the gateway starts or when you run `tools/init-db.mjs`.

## Migrations

New migrations should go into `db/migrations` and follow the naming pattern `NNNN_description.sql`. They are executed in filename order by `tools/migrate-db.mjs`, which also ensures each file is run only once.

### Typical workflow

1. Create a new SQL file under `db/migrations/`.
2. Run `./tools/migrate-db.mjs` to apply the pending files.
3. Verify the gateway (or database client) recognizes the updated schema.

The migration runner will create the `migrations` table if it does not exist and log each step to stdout.
