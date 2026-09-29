// PostgreSQL connection configuration.
//
// The application reads connection settings from the standard environment
// variables. `DATABASE_URL` takes precedence; otherwise the discrete PG*
// variables are used. The schema (namespace) defaults to `public` but can be
// overridden with HELIX_DB_SCHEMA for multi-tenant single-database installs.

function discrete(database) {
  return {
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "helix",
    password: process.env.PGPASSWORD || "helix",
    database,
    ssl: /^(1|true|yes)$/i.test(String(process.env.PGSSL || ""))
      ? { rejectUnauthorized: false }
      : undefined,
  };
}

function fromUrl(url, overrideDatabase) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username || ""),
    password: decodeURIComponent(parsed.password || ""),
    database: overrideDatabase || parsed.pathname.replace(/^\//, "") || "helix",
    ssl: parsed.searchParams.get("sslmode") === "disable" ? undefined : { rejectUnauthorized: false },
  };
}

// Connection settings for a named database. `database` defaults to the
// configured primary database.
export function databaseConfig(database) {
  if (process.env.DATABASE_URL) {
    return fromUrl(process.env.DATABASE_URL, database || undefined);
  }
  return discrete(database || process.env.PGDATABASE || "helix");
}

// The namespace used for the primary schema. Validated so it can be safely
// interpolated into `search_path`.
export function databaseSchema() {
  const schema = process.env.HELIX_DB_SCHEMA || "public";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(`Invalid HELIX_DB_SCHEMA value: ${schema}`);
  }
  return schema;
}

// Database used by the automated test suite. The suite keeps a schema-only and
// a fully seeded template database, and hands each test a physical clone of the
// appropriate template, giving per-test isolation without rebuilding the
// 495-table schema or replaying the seed for every test.
export function testDatabaseName() {
  return process.env.HELIX_TEST_DB || "helix_test_shared";
}

export function poolMax() {
  return Number(process.env.PG_POOL_MAX || 5);
}
