const { pool } = require('./db/primary');

async function showSchema() {
  try {
    const result = await pool.query(
      'SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position',
      ['users']
    );
    console.log('Users table columns:');
    console.log('====================');
    result.rows.forEach(col => {
      const nullable = col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
      console.log(`${col.column_name.padEnd(30)} ${col.data_type.padEnd(15)} ${nullable}`);
    });
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

showSchema();
