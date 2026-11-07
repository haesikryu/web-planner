import { eq } from "drizzle-orm";
import { getAuthRuntime } from "@/server/auth/runtime";
import { resolveSession } from "@/server/auth/session";
import { session } from "@/server/db/schema";
import { apiError, csrfToken, privateHeaders, validCsrf, validOrigin } from "@/server/auth/security";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const { config, db, auth } = getAuthRuntime();
    if (!validOrigin(request, config.baseUrl)) return apiError(403, "FORBIDDEN", "요청 출처를 확인해주세요.");
    const current = await resolveSession(request.headers);
    if (current) {
      if (!validCsrf(request.headers.get("x-csrf-token"), csrfToken(current.session.id, config.secret))) return apiError(403, "FORBIDDEN", "요청을 다시 확인해주세요.");
      // Fail closed on DB deletion errors; Better Auth signOut alone can swallow them.
      await db.delete(session).where(eq(session.id, current.session.id));
    }
    const result = await auth.api.signOut({ headers: request.headers, asResponse: true });
    const headers = new Headers(privateHeaders);
    for (const cookie of result.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 204, headers });
  } catch { return apiError(503, "AUTH_UNAVAILABLE", "로그아웃을 완료할 수 없습니다. 다시 시도해주세요."); }
}
