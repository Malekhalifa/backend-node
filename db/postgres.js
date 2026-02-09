const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.PG_URI,
});

// Auto-create audit_log table on first connection
pool.query(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id serial PRIMARY KEY,
    job_id text,
    event_type text NOT NULL,
    payload jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
`).catch(err => console.error('Auto-create audit_log failed:', err.message));

async function auditLog(jobId, eventType, payload = {}) {
  await pool.query(
    'INSERT INTO audit_log(job_id, event_type, payload, created_at) VALUES($1,$2,$3,now())',
    [jobId, eventType, payload]
  );
}

module.exports = { pool, auditLog };

