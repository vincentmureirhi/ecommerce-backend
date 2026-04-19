const pool = require('./config/database');

async function checkSchema() {
  try {
    const products = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name='products'
      ORDER BY ordinal_position
    `);

    const payments = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name='payments'
      ORDER BY ordinal_position
    `);

    const orderItems = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name='order_items'
      ORDER BY ordinal_position
    `);

    console.log('\n📦 PRODUCTS COLUMNS:');
    products.rows.forEach(row => console.log(`  - ${row.column_name} (${row.data_type})`));

    console.log('\n💳 PAYMENTS COLUMNS:');
    payments.rows.forEach(row => console.log(`  - ${row.column_name} (${row.data_type})`));

    console.log('\n📝 ORDER_ITEMS COLUMNS:');
    orderItems.rows.forEach(row => console.log(`  - ${row.column_name} (${row.data_type})`));

    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
}

checkSchema();