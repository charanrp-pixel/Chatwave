const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

async function initializeDatabase() {
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await pool.query(schema);
    console.log('✅ Database schema initialized');
  } catch (err) {
    if (err.code !== '42P07' && !err.message.includes('already exists')) {
      console.error('❌ Database initialization error:', err.message);
    } else {
      console.log('✅ Database already initialized');
    }
  }
}

module.exports = { pool, initializeDatabase };
