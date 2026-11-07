import { betterAuth } from "better-auth";
import { randomUUID } from "node:crypto";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import type { DBAdapter } from "better-auth/adapters";
import { verifyGoogleIdToken } from "better-auth/social-providers";
import { getOAuthState } from "better-auth/api";
import { timezone } from "../../domain/rules";
import type { AuthConfiguration } from "../config";
import { protectStorage } from "./storage";

export const IDLE_SECONDS = 12 * 60 * 60;
export const ABSOLUTE_SECONDS = 7 * 24 * 60 * 60;

/** Google 1.7.18 does not opt into nonce binding itself. Use the supported provider extension. */
const googleNonce = (clientId: string, allowedEmails: readonly string[]): BetterAuthPlugin => ({
  id: "planner-google-nonce",
  init(context) {
    const provider = context.socialProviders.find(item => item.id === "google");
    if (!provider) throw new Error("Google provider unavailable");
    provider.requiresIdTokenNonce = true;
    provider.issuer = "https://accounts.google.com";
    const createURL = provider.createAuthorizationURL.bind(provider);
    provider.createAuthorizationURL = async parameters => {
      if (!parameters.idTokenNonce) throw new Error("Missing authorization nonce");
      const url = await createURL(parameters);
      url.searchParams.set("nonce", parameters.idTokenNonce);
      return url;
    };
    provider.getUserInfo = async tokens => {
      if (!tokens.idToken || !tokens.expectedIdTokenNonce) return null;
      const claims = await verifyGoogleIdToken({ token: tokens.idToken, audience: clientId, nonce: tokens.expectedIdTokenNonce });
      if (!claims || typeof claims.sub !== "string" || !claims.sub || typeof claims.email !== "string" || claims.email_verified !== true) return null;
      if (!allowedEmails.includes(claims.email.trim().toLowerCase())) return null;
      return { user: { email: claims.email, emailVerified: true, name: "", image: undefined }, data: claims };
    };
  }
});

export function createPlannerAuth(config: AuthConfiguration, database: (options: BetterAuthOptions) => DBAdapter, allowSignUp = false) {
  const secure = new URL(config.baseUrl).protocol === "https:";
  return betterAuth({
    appName: "Web Planner", baseURL: config.baseUrl, basePath: "/api/auth", secret: config.secret,
    database: (options: BetterAuthOptions) => protectStorage(database(options)),
    trustedOrigins: [config.baseUrl], emailAndPassword: { enabled: false },
    socialProviders: { google: {
      clientId: config.google.clientId, clientSecret: config.google.clientSecret,
      disableSignUp: !allowSignUp,
      disableDefaultScope: true, scope: ["openid", "email"], includeGrantedScopes: false,
      prompt: "select_account", accessType: "online"
    } },
    account: { accountLinking: { enabled: false, disableImplicitLinking: true }, storeAccountCookie: false },
    session: { expiresIn: ABSOLUTE_SECONDS, disableSessionRefresh: true, cookieCache: { enabled: false } },
    user: { additionalFields: {
      timezone: { type: "string", required: false, defaultValue: "UTC", input: false },
      settingsVersion: { type: "number", required: false, defaultValue: 1, input: false }
    } },
    databaseHooks: { user: { create: { before: async data => {
      const state = await getOAuthState();
      let initialTimezone = "UTC";
      try { initialTimezone = timezone(state?.initialTimezone); } catch { /* Invalid or absent device suggestion uses UTC. */ }
      return { data: { ...data, timezone: initialTimezone } };
    } } } },
    advanced: {
      database: { generateId: () => randomUUID() },
      useSecureCookies: false,
      defaultCookieAttributes: { secure, httpOnly: true, sameSite: "lax", path: "/" },
      cookies: { session_token: { name: secure ? "__Host-planner-session" : "planner-session" } }
    },
    logger: { disabled: true },
    onAPIError: { throw: true, errorURL: `${config.baseUrl}/?auth=error` },
    plugins: [googleNonce(config.google.clientId, config.allowedEmails)]
  });
}
