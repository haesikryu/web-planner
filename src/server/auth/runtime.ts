import { drizzle } from "drizzle-orm/node-postgres";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { Pool } from "pg";
import { readAuthConfiguration } from "../config";
import * as schema from "../db/schema";
import { createPlannerAuth } from "./factory";

let runtime: ReturnType<typeof initialize> | undefined;
function initialize() {
  const config = readAuthConfiguration(process.env, process.env.NODE_ENV === "production");
  const pool = new Pool({ connectionString: config.databaseUrl, max: 5, connectionTimeoutMillis: 5000 });
  const db = drizzle(pool, { schema });
  const auth = createPlannerAuth(config, drizzleAdapter(db, { provider: "pg", schema, transaction: true }), process.env.AUTH_ALLOW_SIGN_UP === "true");
  return { config, db, auth };
}
export const getAuthRuntime = () => runtime ??= initialize();
