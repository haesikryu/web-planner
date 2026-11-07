import { generateKeyPairSync, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeSignature } from "better-auth/crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "../../src/server/db/schema";
import { createPlannerAuth } from "../../src/server/auth/factory";
import { hashToken } from "../../src/server/auth/storage";
import { GET as getSession } from "../../src/app/api/session/route";
import { POST as logout } from "../../src/app/api/logout/route";
import { POST as startLogin, GET as callback } from "../../src/app/api/auth/[...all]/route";

vi.mock("../../src/server/auth/runtime", () => ({ getAuthRuntime: () => ({ auth, db, config }) }));

const pg = new PGlite();
const db = drizzle(pg, { schema });
const config = { baseUrl: "https://planner.example", databaseUrl: "unused", secret: "synthetic-only-secret-32-characters-long", google: { clientId: "test-google-client", clientSecret: "synthetic-client-secret" } };
const auth = createPlannerAuth(config, drizzleAdapter(db, { provider: "pg", schema, transaction: true }), true);
const alice = "10000000-0000-4000-8000-000000000001";
const bob = "10000000-0000-4000-8000-000000000002";

beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./migrations" });
  await db.insert(schema.user).values([
    { id: alice, name: "", email: "alice@example.test" }, { id: bob, name: "", email: "bob@example.test" }
  ]);
}, 30000);
afterAll(async () => { vi.unstubAllGlobals(); await pg.close(); });

describe("PostgreSQL schema and adapter integration (PGlite)", () => {
  it("keeps new sign-ups closed until an explicit environment policy is configured", () => {
    const closed = createPlannerAuth(config, drizzleAdapter(db, { provider: "pg", schema, transaction: true }));
    expect(closed.options.socialProviders?.google).toMatchObject({ disableSignUp: true });
  });
  it("reapplies migration without losing records", async () => {
    await migrate(db, { migrationsFolder: "./migrations" });
    expect((await db.select().from(schema.user))).toHaveLength(2);
  });
  it("rejects invalid title, version and completion combinations", async () => {
    for (const input of [ { title: "" }, { title: "x".repeat(201) }, { title: "line\nbreak" }, { title: " padded " },
      { title: "valid", version: 0 }, { title: "valid", status: "completed" } ]) {
      await expect(db.insert(schema.tasks).values({ ownerId: alice, ...input })).rejects.toThrow();
    }
    const rows = await db.insert(schema.tasks).values({ ownerId: alice, title: "😀".repeat(200) }).returning();
    expect(rows[0].status).toBe("open");
  });
  it("blocks cross-owner activity and cross-task invalidation", async () => {
    const [taskA, taskB] = await db.insert(schema.tasks).values([
      { ownerId: alice, title: "A" }, { ownerId: alice, title: "B" }
    ]).returning();
    await expect(db.insert(schema.taskActivities).values({ ownerId: bob, taskId: taskA.id, type: "completed" })).rejects.toThrow();
    const [other] = await db.insert(schema.taskActivities).values({ ownerId: alice, taskId: taskB.id, type: "completion_undone" }).returning();
    await expect(db.insert(schema.taskActivities).values({ ownerId: alice, taskId: taskA.id, type: "completed", invalidatedBy: other.id })).rejects.toThrow();
  });
  it("scopes unique request keys to owners and rolls back failed transactions", async () => {
    const value = { ownerId: alice, method: "POST", path: "/api/tasks", key: "same-key", requestHash: "a".repeat(64), state: "processing", expiresAt: new Date(Date.now() + 86400000) };
    await db.insert(schema.idempotencyRecords).values(value);
    await expect(db.insert(schema.idempotencyRecords).values(value)).rejects.toThrow();
    await db.insert(schema.idempotencyRecords).values({ ...value, ownerId: bob });
    const before = (await db.select().from(schema.tasks)).length;
    await expect(db.transaction(async tx => {
      await tx.insert(schema.tasks).values({ ownerId: alice, title: "must roll back" });
      await tx.insert(schema.idempotencyRecords).values(value);
    })).rejects.toThrow();
    expect((await db.select().from(schema.tasks))).toHaveLength(before);
  });
  it("stores session digest and supports lookup, refresh, transaction and revocation", async () => {
    const ctx = await auth.$context;
    const issued = await ctx.internalAdapter.createSession(alice);
    const stored = await db.select().from(schema.session);
    expect(stored[0].token).toBe(hashToken(issued.token));
    expect(stored[0].token).not.toBe(issued.token);
    expect((await ctx.internalAdapter.findSession(issued.token))?.user.id).toBe(alice);
    await ctx.internalAdapter.updateSession(issued.token, { updatedAt: new Date() });
    expect(await ctx.internalAdapter.findSession(stored[0].token)).toBeNull();
    await ctx.adapter.transaction(async tx => {
      const found = await tx.findOne<{ token: string }>({ model: "session", where: [{ field: "token", value: issued.token }] });
      expect(found?.token).toBe(issued.token);
    });
    await ctx.internalAdapter.deleteSession(issued.token);
    expect(await ctx.internalAdapter.findSession(issued.token)).toBeNull();
  });
  it("does not store provider credentials or link identities by email", async () => {
    const ctx = await auth.$context;
    await ctx.adapter.create({ model: "account", data: {
      userId: alice, providerId: "google", accountId: "google-sub-alice", accessToken: "synthetic-access-token",
      refreshToken: "synthetic-refresh-token", idToken: "synthetic-id-token", createdAt: new Date(), updatedAt: new Date()
    } });
    const [stored] = await db.select().from(schema.account);
    expect([stored.accessToken, stored.refreshToken, stored.idToken]).toEqual([null, null, null]);
    await expect(ctx.adapter.create({ model: "account", data: { userId: bob, providerId: "google", accountId: "google-sub-alice", createdAt: new Date(), updatedAt: new Date() } })).rejects.toThrow();
    expect(auth.options.account?.accountLinking?.enabled).toBe(false);
  });
  it("starts Google redirect with only login scopes, state, nonce and S256 PKCE", async () => {
    const response = await auth.handler(new Request("https://planner.example/api/auth/sign-in/social", {
      method: "POST", headers: { origin: config.baseUrl, "content-type": "application/json" },
      body: JSON.stringify({ provider: "google", callbackURL: "/", disableRedirect: true })
    }));
    expect(response.status).toBe(200);
    const url = new URL((await response.json()).url);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual(["email", "openid"]);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toHaveLength(32);
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toBe("https://planner.example/api/auth/callback/google");
    expect(url.searchParams.get("include_granted_scopes")).toBeNull();
  });
  it("verifies signed ID tokens and rejects nonce, issuer, audience, expiry and key failures", async () => {
    const provider = (await auth.$context).socialProviders[0];
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "synthetic-key", alg: "RS256", use: "sig" };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input) !== "https://www.googleapis.com/oauth2/v3/certs") throw new Error("Unexpected external request in isolated test");
      return Response.json({ keys: [jwk] });
    }));
    const now = Math.floor(Date.now() / 1000);
    const token = (changes: Record<string, unknown> = {}, wrongKey = false) => {
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: wrongKey ? "unknown" : "synthetic-key" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: config.google.clientId, sub: "google-sub-alice", email: "alice@example.test", email_verified: true, nonce: "expected-nonce", iat: now, exp: now + 300, ...changes })).toString("base64url");
      const value = `${header}.${payload}`;
      return `${value}.${sign("RSA-SHA256", Buffer.from(value), privateKey).toString("base64url")}`;
    };
    const info = (idToken: string, nonce: string | undefined = "expected-nonce") => provider.getUserInfo({ idToken, expectedIdTokenNonce: nonce });
    expect((await info(token()))?.data).toMatchObject({ sub: "google-sub-alice" });
    for (const changes of [{ nonce: "wrong" }, { iss: "https://attacker.test" }, { aud: "other-client" }, { exp: now - 100 }, { email_verified: false }]) {
      expect(await info(token(changes))).toBeNull();
    }
    expect(await info(token({}, true))).toBeNull();
    expect(await provider.getUserInfo({ idToken: token() })).toBeNull();
    const tampered = token().split("."); tampered[1] = Buffer.from('{"sub":"attacker"}').toString("base64url");
    expect(await info(tampered.join("."))).toBeNull();
    vi.unstubAllGlobals();
  });
  it("enforces product session contract, CSRF, logout and production cookie attributes", async () => {
    const ctx = await auth.$context;
    const issued = await ctx.internalAdapter.createSession(alice);
    const cookie = `__Host-planner-session=${encodeURIComponent(`${issued.token}.${await makeSignature(issued.token, config.secret)}`)}`;
    const response = await getSession(new Request(`${config.baseUrl}/api/session`, { headers: { cookie } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["csrfToken", "serverDate", "settingsVersion", "timezone", "userId"]);
    expect(body).toMatchObject({ userId: alice, timezone: "UTC", settingsVersion: 1 });
    const out = (origin: string, token: string) => logout(new Request(`${config.baseUrl}/api/logout`, { method: "POST", headers: { cookie, origin, "x-csrf-token": token } }));
    expect((await out("https://attacker.test", body.csrfToken)).status).toBe(403);
    expect((await out(config.baseUrl, "wrong-token")).status).toBe(403);
    expect(await ctx.internalAdapter.findSession(issued.token)).not.toBeNull();
    const ended = await out(config.baseUrl, body.csrfToken);
    expect(ended.status).toBe(204);
    expect(ended.headers.getSetCookie().join(";")).toMatch(/__Host-planner-session=;.*Max-Age=0/i);
    expect(await ctx.internalAdapter.findSession(issued.token)).toBeNull();
    expect((await getSession(new Request(`${config.baseUrl}/api/session`, { headers: { cookie } }))).status).toBe(401);
    expect((await out(config.baseUrl, "")).status).toBe(204);
    expect(ctx.authCookies.sessionToken).toMatchObject({ name: "__Host-planner-session", attributes: { secure: true, httpOnly: true, sameSite: "lax", path: "/" } });
    expect(ctx.authCookies.sessionToken.attributes.domain).toBeUndefined();
  });
  it("does not revive idle or absolutely expired sessions", async () => {
    const ctx = await auth.$context;
    for (const patch of [ { updatedAt: new Date(Date.now() - 13 * 3600000) }, { createdAt: new Date(Date.now() - 8 * 86400000) } ]) {
      const issued = await ctx.internalAdapter.createSession(alice);
      await db.update(schema.session).set(patch).where(eq(schema.session.id, issued.id));
      const cookie = `__Host-planner-session=${encodeURIComponent(`${issued.token}.${await makeSignature(issued.token, config.secret)}`)}`;
      expect((await getSession(new Request(`${config.baseUrl}/api/session`, { headers: { cookie } }))).status).toBe(401);
      expect(await ctx.internalAdapter.findSession(issued.token)).toBeNull();
    }
  });
  it("blocks direct token login, untrusted origins and library bypass endpoints", async () => {
    const request = (body: unknown, origin = config.baseUrl) => new Request(`${config.baseUrl}/api/auth/sign-in/social`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await startLogin(request({ provider: "google" }, "https://attacker.test"))).status).toBe(403);
    expect((await startLogin(request({ provider: "google", idToken: { token: "synthetic" } }))).status).toBe(422);
    expect((await startLogin(request({ provider: "github" }))).status).toBe(422);
    expect((await callback(new Request(`${config.baseUrl}/api/auth/get-session`))).status).toBe(404);
    const rejected = await callback(new Request(`${config.baseUrl}/api/auth/callback/google?code=synthetic&state=invalid`));
    expect(rejected.headers.get("location")).toBe(`${config.baseUrl}/?auth=error`);
    expect((await db.select().from(schema.session))).toHaveLength(0);
  });
  it("completes a synthetic signed Google callback, consumes state once, and refuses email-based merging", async () => {
    const provider = (await auth.$context).socialProviders[0];
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "callback-key", alg: "RS256" }] })));
    const perform = async (subject: string, email: string) => {
      const started = await startLogin(new Request(`${config.baseUrl}/api/auth/sign-in/social`, { method: "POST", headers: { origin: config.baseUrl, "content-type": "application/json" }, body: JSON.stringify({ provider: "google", callbackURL: "https://attacker.test" }) }));
      const url = new URL((await started.json()).url);
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "callback-key" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: config.google.clientId, sub: subject, email, email_verified: true, nonce: url.searchParams.get("nonce"), iat: now, exp: now + 300 })).toString("base64url");
      const signed = `${header}.${payload}`;
      const idToken = `${signed}.${sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url")}`;
      const exchange = vi.spyOn(provider, "validateAuthorizationCode").mockResolvedValue({ idToken, accessToken: "synthetic-provider-access" });
      const cookie = started.headers.getSetCookie().map(item => item.split(";")[0]).join("; ");
      const request = () => new Request(`${config.baseUrl}/api/auth/callback/google?code=synthetic&state=${url.searchParams.get("state")}`, { headers: { cookie } });
      const completed = await callback(request());
      exchange.mockRestore();
      return { completed, request };
    };
    try {
      const { completed, request } = await perform("google-sub-alice", "alice@example.test");
      expect(completed.status).toBe(302);
      expect(new URL(completed.headers.get("location") ?? "", config.baseUrl).origin).toBe(config.baseUrl);
      const loginCookie = completed.headers.getSetCookie().find(item => item.startsWith("__Host-planner-session="));
      expect(loginCookie).toMatch(/HttpOnly/);
      expect(loginCookie).toMatch(/Secure/);
      expect(loginCookie).toMatch(/SameSite=Lax/i);
      const replay = await callback(request());
      expect(replay.headers.get("location")).toBe(`${config.baseUrl}/?auth=error`);
      expect(await db.select().from(schema.session)).toHaveLength(1);
      const blocked = await perform("other-google-sub-same-email", "alice@example.test");
      expect(blocked.completed.headers.get("location")).toBe(`${config.baseUrl}/?auth=error`);
      expect(await db.select().from(schema.user)).toHaveLength(2);
      const created = await perform("google-sub-new-person", "new-person@example.test");
      expect(created.completed.headers.getSetCookie().some(item => item.startsWith("__Host-planner-session="))).toBe(true);
      const users = await db.select().from(schema.user);
      expect(users).toHaveLength(3);
      expect(users.find(item => item.email === "new-person@example.test")).toMatchObject({ timezone: "UTC", settingsVersion: 1 });
    } finally { vi.unstubAllGlobals(); }
  });
  it("restores an isolated database snapshot with schema, migration journal and records", async () => {
    const archive = await pg.dumpDataDir();
    const restored = await PGlite.create({ loadDataDir: archive });
    try {
      const restoredDb = drizzle(restored, { schema });
      await migrate(restoredDb, { migrationsFolder: "./migrations" });
      expect(await restoredDb.select().from(schema.user)).toEqual(await db.select().from(schema.user));
      expect(await restoredDb.select().from(schema.tasks)).toEqual(await db.select().from(schema.tasks));
    } finally { await restored.close(); }
  }, 30000);
});
