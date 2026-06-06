const { pool } = require('./db/primary');

async function queryReviewer() {
  try {
    const result = await pool.query(
      'SELECT id, email, email_verified, device_id, wallet_address, is_mining, is_flagged, flag_reason, preferred_language, device_fingerprint, is_trusted_device, created_at, updated_at FROM users WHERE email = $1 LIMIT 1',
      ['reviewer@a-network.net']
    );
    
    if (result.rows.length === 0) {
      console.log('No reviewer account found in database');
    } else {
      const user = result.rows[0];
      console.log('\n✅ Reviewer Account Found in PostgreSQL:');
      console.log('==========================================');
      console.log(JSON.stringify(user, null, 2));
    }
  } catch (err) {
    console.error('Query error:', err.message);
  } finally {
    await pool.end();
  }
}

queryReviewer();
