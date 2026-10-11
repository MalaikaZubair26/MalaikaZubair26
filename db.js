require('dotenv').config();
const { Pool } = require('pg');

// Check for a Neon Cloud DATABASE_URL first, otherwise fall back to local
// settings. SSL is only turned on for a cloud connection — a local Postgres
// install (the documented default setup) usually doesn't support SSL at all,
// so forcing it on unconditionally would break `npm start` for local dev.
const usingCloudDb = !!process.env.DATABASE_URL || (process.env.PGHOST || '').includes('neon.tech');

const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Required for Neon Cloud
    }
  : {
      host: process.env.PGHOST || 'localhost',
      port: parseInt(process.env.PGPORT, 10) || 5432,
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || '',
      database: process.env.PGDATABASE || 'donerkebabtacos',
      ssl: usingCloudDb ? { rejectUnauthorized: false } : undefined,
    };

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL error:', err);
});

module.exports = pool;