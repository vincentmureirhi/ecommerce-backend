'use strict';

const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing');
  process.exit(1);
}

function envFlag(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return defaultValue;

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function envInt(name, defaultValue, options = {}) {
  const parsed = Number(process.env[name]);
  const min = options.min ?? 0;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;

  if (!Number.isInteger(parsed)) return defaultValue;
  return Math.min(Math.max(parsed, min), max);
}

const logConnections = envFlag('DB_LOG_CONNECTIONS', false);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: envFlag('DATABASE_SSL_DISABLED', false)
    ? false
    : {
        rejectUnauthorized: false,
      },
  max: envInt('DB_POOL_MAX', 10, { min: 1, max: 100 }),
  min: envInt('DB_POOL_MIN', 0, { min: 0, max: 100 }),
  idleTimeoutMillis: envInt('DB_IDLE_TIMEOUT_MS', 30000, { min: 1000, max: 600000 }),
  connectionTimeoutMillis: envInt('DB_CONNECTION_TIMEOUT_MS', 10000, { min: 1000, max: 60000 }),
  statement_timeout: envInt('DB_STATEMENT_TIMEOUT_MS', 30000, { min: 0, max: 300000 }),
  query_timeout: envInt('DB_QUERY_TIMEOUT_MS', 30000, { min: 0, max: 300000 }),
  keepAlive: true,
  keepAliveInitialDelayMillis: envInt('DB_KEEPALIVE_INITIAL_DELAY_MS', 10000, {
    min: 0,
    max: 60000,
  }),
});

pool.on('connect', () => {
  if (logConnections) {
    console.log('PostgreSQL client connected');
  }
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err.message);
});

(async () => {
  try {
    const client = await pool.connect();

    console.log('DATABASE CONNECTION SUCCESS');

    const result = await client.query('SELECT current_database(), current_user');

    console.log(result.rows[0]);

    client.release();
  } catch (err) {
    console.error('DATABASE CONNECTION FAILED');
    console.error(err.message);

    process.exit(1);
  }
})();

module.exports = pool;
