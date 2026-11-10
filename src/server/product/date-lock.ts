import { sql } from "drizzle-orm";
import { HttpError } from "./http";
import type { Transaction } from "./write";

export async function lockDate(tx: Transaction, scope: string, owner: string, date: string): Promise<void> {
  try {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([scope, owner, date])}, 0))`);
  } catch (error) {
    const cause = error instanceof Error && "cause" in error ? error.cause : error;
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "55P03") {
      throw new HttpError(409, "REQUEST_IN_PROGRESS", "같은 날짜의 변경을 처리 중입니다. 같은 요청으로 다시 시도해주세요.");
    }
    throw error;
  }
}
