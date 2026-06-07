'use strict';

const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is missing');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  ssl: {
    rejectUnauthorized: false,
  },
});

pool.on('connect', () => {
  console.log('✅ PostgreSQL connected');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL error:', err.message);
});

(async () => {
  try {
    const client = await pool.connect();

    console.log('✅ DATABASE CONNECTION SUCCESS');

    const result = await client.query(
      'SELECT current_database(), current_user'
    );

    console.log(result.rows[0]);

    client.release();
  } catch (err) {
    console.error('❌ DATABASE CONNECTION FAILED');
    console.error(err.message);

    process.exit(1);
  }
})();

module.exports = pool;