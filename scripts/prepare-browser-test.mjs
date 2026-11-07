import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const url = process.env.PLANNER_E2E_DATABASE_URL;
if (!url || new URL(url).hostname !== "127.0.0.1" || new URL(url).pathname !== "/planner_test_e2e") throw new Error("Use the named loopback disposable planner_test_e2e database");
const pool = new Pool({ connectionString: url, max: 1 });
try { await migrate(drizzle(pool), { migrationsFolder: "./migrations" }); }
finally { await pool.end(); }
