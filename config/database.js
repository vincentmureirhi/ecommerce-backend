'use strict';

const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

function reqEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

const config = {
  host: reqEnv('DB_HOST'),
  port: Number(reqEnv('DB_PORT')),
  database: reqEnv('DB_NAME'),
  user: reqEnv('DB_USER'),
  password: reqEnv('DB_PASSWORD'),
};

if (!Number.isInteger(config.port) || config.port < 1) {
  throw new Error(`DB_PORT must be a valid integer. Got: ${process.env.DB_PORT}`);
}

const pool = new Pool(config);

pool.on('error', (err) => {
  console.error('❌ Unexpected error on idle pg client:', err.message);
});

// Test connection at startup (fail fast)
(async () => {
  try {
    const res = await pool.query('SELECT current_user, current_database(), inet_server_addr() AS host, inet_server_port() AS port');
    const row = res.rows[0];
    console.log('✅ DATABASE CONNECTED');
    console.log('--------------------------------------');
    console.log('User      :', row.current_user);
    console.log('Database  :', row.current_database);
    console.log('Host      :', row.host);
    console.log('Port      :', row.port);
    console.log('Env file  :', path.resolve(process.cwd(), '.env'));
    console.log('════════════════');
  } catch (err) {
    console.error('❌ DATABASE CONNECTION FAILED');
    console.error(err.message);
    console.error('\nWhat Node THINKS it is using:');
    console.error({
      DB_HOST: process.env.DB_HOST,
      DB_PORT: process.env.DB_PORT,
      DB_NAME: process.env.DB_NAME,
      DB_USER: process.env.DB_USER,
      DB_PASSWORD: process.env.DB_PASSWORD ? 'SET' : 'MISSING',
      ENV_PATH: path.resolve(process.cwd(), '.env'),
      CWD: process.cwd(),
    });
    console.error('\nFix your .env / environment variables, then restart.');
    process.exit(1);
  }
})();

module.exports = pool;