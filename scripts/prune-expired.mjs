import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
let client;
try {
  client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout = '10s'");
  const records = await client.query("DELETE FROM idempotency_records WHERE ctid IN (SELECT ctid FROM idempotency_records WHERE expires_at <= now() LIMIT 5000)");
  const states = await client.query("DELETE FROM verifications WHERE ctid IN (SELECT ctid FROM verifications WHERE expires_at <= now() LIMIT 5000)");
  const sessions = await client.query("DELETE FROM sessions WHERE ctid IN (SELECT ctid FROM sessions WHERE expires_at <= now() OR created_at <= now() - interval '7 days' OR updated_at <= now() - interval '12 hours' LIMIT 5000)");
  await client.query("COMMIT");
  console.log(JSON.stringify({ expiredRequestRecords: records.rowCount, expiredOAuthStates: states.rowCount, expiredSessions: sessions.rowCount }));
} catch {
  if (client) await client.query("ROLLBACK"); console.error("Expired-record cleanup failed; details omitted."); process.exitCode = 1;
} finally { client?.release(); await pool.end(); }
