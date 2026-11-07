import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required. Use an ignored local environment file.");
  process.exitCode = 1;
} else {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "./migrations" });
    console.log("Database migrations completed.");
  } catch {
    console.error("Database migration failed. Connection details are intentionally omitted.");
    process.exitCode = 1;
  } finally { await pool.end(); }
}
