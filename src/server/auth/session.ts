import { and, eq, gt } from "drizzle-orm";
import { session } from "../db/schema";
import { ABSOLUTE_SECONDS, IDLE_SECONDS } from "./factory";
import { getAuthRuntime } from "./runtime";

export async function resolveSession(headers: Headers) {
  const runtime = getAuthRuntime();
  const identity = await runtime.auth.api.getSession({ headers });
  if (!identity) return null;
  if (!runtime.config.allowedEmails.includes(identity.user.email.trim().toLowerCase())) {
    await runtime.db.delete(session).where(eq(session.id, identity.session.id));
    return null;
  }
  const now = new Date();
  // Check and touch in one conditional write: idle expiry cannot be revived by competing requests.
  const rows = await runtime.db.update(session).set({ updatedAt: now }).where(and(
    eq(session.id, identity.session.id), gt(session.expiresAt, now),
    gt(session.createdAt, new Date(now.getTime() - ABSOLUTE_SECONDS * 1000)),
    gt(session.updatedAt, new Date(now.getTime() - IDLE_SECONDS * 1000))
  )).returning({ id: session.id });
  if (!rows.length) {
    await runtime.db.delete(session).where(eq(session.id, identity.session.id));
    return null;
  }
  return identity;
}
