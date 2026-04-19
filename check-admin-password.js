const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  password: 'vinnie',
  host: 'localhost',
  port: 5432,
  database: 'ecommerce_db',
});

async function checkAdmins() {
  try {
    const result = await pool.query(
      `SELECT id, email, role, password_hash FROM users WHERE role IN ('admin', 'superuser') ORDER BY created_at DESC`
    );

    console.log('📊 Admin Accounts:\n');
    result.rows.forEach(user => {
      console.log(`   Email: ${user.email}`);
      console.log(`   Role: ${user.role}`);
      console.log(`   ID: ${user.id}`);
      console.log('');
    });

    await pool.end();
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

checkAdmins();