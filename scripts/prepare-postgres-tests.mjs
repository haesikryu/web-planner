import { Pool } from "pg";

const source = process.env.PLANNER_TEST_DATABASE_URL;
if (!source || new URL(source).hostname !== "127.0.0.1" || new URL(source).pathname !== "/planner_test_product") throw new Error("Use only the named loopback disposable test databases");
const url = new URL(source); url.pathname = "/postgres";
const pool = new Pool({ connectionString: url.toString(), max: 1 });
try {
  const result = await pool.query("SELECT 1 FROM pg_database WHERE datname = 'planner_test_e2e'");
  if (!result.rowCount) await pool.query("CREATE DATABASE planner_test_e2e");
} finally { await pool.end(); }
