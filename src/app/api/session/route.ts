import { resolveSession } from "@/server/auth/session";
import { getAuthRuntime } from "@/server/auth/runtime";
import { apiError, csrfToken, privateHeaders } from "@/server/auth/security";
import { today } from "@/domain/rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!request.headers.get("cookie")) return apiError(401, "UNAUTHENTICATED", "로그인이 필요합니다.");
  try {
    const current = await resolveSession(request.headers);
    if (!current) return apiError(401, "UNAUTHENTICATED", "로그인이 필요합니다.");
    const timezone = current.user.timezone ?? "UTC";
    const serverDate = today(timezone);
    return Response.json({ userId: current.user.id, timezone, settingsVersion: current.user.settingsVersion ?? 1, serverDate,
      csrfToken: csrfToken(current.session.id, getAuthRuntime().config.secret) }, { headers: privateHeaders });
  } catch { return apiError(503, "AUTH_UNAVAILABLE", "로그인 상태를 확인할 수 없습니다."); }
}
