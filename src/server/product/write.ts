import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getAuthRuntime } from "../auth/runtime";
import { idempotencyRecords } from "../db/schema";
import { HttpError, type SavedResponse } from "./http";

export type Transaction = Parameters<Parameters<ReturnType<typeof getAuthRuntime>["db"]["transaction"]>[0]>[0];
export async function writeOnce(ownerId: string, method: string, path: string, key: string, payload: unknown,
  action: (tx: Transaction) => Promise<SavedResponse>, authorize?: (tx: Transaction) => Promise<void>): Promise<SavedResponse> {
  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return getAuthRuntime().db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
    if (authorize) await authorize(tx);
    const scope = JSON.stringify([ownerId, method, path, key]);
    const lock = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${scope}, 0)) as locked`);
    if (!lock.rows[0].locked) throw new HttpError(409, "REQUEST_IN_PROGRESS", "같은 요청을 처리 중입니다.");
    const where = and(eq(idempotencyRecords.ownerId, ownerId), eq(idempotencyRecords.method, method), eq(idempotencyRecords.path, path), eq(idempotencyRecords.key, key));
    const [existing] = await tx.select().from(idempotencyRecords).where(where);
    const now = new Date();
    if (existing && existing.expiresAt > now) {
      if (existing.requestHash !== hash) throw new HttpError(409, "IDEMPOTENCY_KEY_REUSED", "다른 내용에 사용한 요청 키입니다.");
      if (existing.state !== "completed") throw new HttpError(409, "REQUEST_IN_PROGRESS", "같은 요청을 처리 중입니다.");
      return existing.response as SavedResponse;
    }
    if (existing) await tx.delete(idempotencyRecords).where(where);
    await tx.insert(idempotencyRecords).values({ ownerId, method, path, key, requestHash: hash, state: "processing", expiresAt: new Date(now.getTime() + 86400000) });
    const response = await action(tx);
    await tx.update(idempotencyRecords).set({ state: "completed", response }).where(where);
    return response;
  });
}
