/** Server-only configuration boundary. Never serialize the returned secrets. */
export type AuthConfiguration = Readonly<{
  baseUrl: string;
  databaseUrl: string;
  secret: string;
  allowedEmails: readonly string[];
  google: Readonly<{ clientId: string; clientSecret: string }>;
}>;

export class ConfigurationError extends Error {
  constructor(public readonly fields: readonly string[]) {
    super(`Invalid server configuration: ${fields.join(", ")}`);
    this.name = "ConfigurationError";
  }
}

export function readAuthConfiguration(
  env: Readonly<Record<string, string | undefined>>,
  production: boolean
): AuthConfiguration {
  const keys = ["BETTER_AUTH_URL", "DATABASE_URL", "BETTER_AUTH_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;
  const values = Object.fromEntries(keys.map(key => [key, env[key]?.trim() ?? ""])) as Record<typeof keys[number], string>;
  const invalid = new Set<string>(keys.filter(key => !values[key]));
  let baseUrl = "";
  try {
    const url = new URL(values.BETTER_AUTH_URL);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && local && !production))) {
      invalid.add("BETTER_AUTH_URL");
    }
    baseUrl = url.origin;
  } catch { invalid.add("BETTER_AUTH_URL"); }
  try {
    const url = new URL(values.DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) invalid.add("DATABASE_URL");
  } catch { invalid.add("DATABASE_URL"); }
  if (Buffer.byteLength(values.BETTER_AUTH_SECRET, "utf8") < 32) invalid.add("BETTER_AUTH_SECRET");
  const allowedEmails = [...new Set((env.AUTH_ALLOWED_EMAILS ?? "").split(",").map(value => value.trim().toLowerCase()))];
  if (!allowedEmails.length || allowedEmails.some(value => !/^[^\s@*,]+@[^\s@*,]+\.[^\s@*,]+$/.test(value))) invalid.add("AUTH_ALLOWED_EMAILS");
  if (invalid.size) throw new ConfigurationError([...invalid]);
  return {
    baseUrl,
    databaseUrl: values.DATABASE_URL,
    secret: values.BETTER_AUTH_SECRET,
    allowedEmails,
    google: { clientId: values.GOOGLE_CLIENT_ID, clientSecret: values.GOOGLE_CLIENT_SECRET }
  };
}
