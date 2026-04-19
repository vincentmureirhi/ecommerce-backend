'use strict';

require('dotenv').config();
const pool = require('../config/database');
const bcrypt = require('bcryptjs');

async function main() {
  const email = (process.env.SEED_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD || '';
  const first = process.env.SEED_ADMIN_FIRST_NAME || 'Admin';
  const last = process.env.SEED_ADMIN_LAST_NAME || 'User';

  if (!email || !password) {
    console.error('Missing SEED_ADMIN_EMAIL or SEED_ADMIN_PASSWORD in .env');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);

  await pool.query(
    `
    INSERT INTO users (first_name, last_name, email, password_hash, role, is_active)
    VALUES ($1,$2,$3,$4,'admin',true)
    ON CONFLICT (email)
    DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      role = 'admin',
      is_active = true,
      updated_at = CURRENT_TIMESTAMP
    `,
    [first, last, email, hash]
  );

  console.log('✅ Admin seeded/updated:', email);
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ Seed failed:', e);
  process.exit(1);
});