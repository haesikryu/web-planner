import { getAuthRuntime } from "@/server/auth/runtime";
import { apiError, validOrigin } from "@/server/auth/security";
import { timezone } from "@/domain/rules";
import { isLoginEnabled } from "@/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(request: Request) {
  const path = new URL(request.url).pathname;
  // Only redirect-based Google sign-in and its callback are public library endpoints.
  // Session lookup, logout and account modification go through our product boundary.
  if (!(request.method === "POST" && path === "/api/auth/sign-in/social") &&
      !(request.method === "GET" && path === "/api/auth/callback/google")) {
    return apiError(404, "NOT_FOUND", "요청한 경로가 없습니다.");
  }
  if (!isLoginEnabled(process.env)) {
    return apiError(503, "AUTH_UNAVAILABLE", "로그인이 일시 중지되었습니다.");
  }
  try {
    const { auth, config } = getAuthRuntime();
    if (request.method === "POST") {
      if (!validOrigin(request, config.baseUrl)) return apiError(403, "FORBIDDEN", "요청 출처를 확인해주세요.");
      if (!request.headers.get("content-type")?.startsWith("application/json")) return apiError(415, "UNSUPPORTED_MEDIA_TYPE", "JSON 요청이 필요합니다.");
      const body = await request.json().catch(() => null);
      if (body?.provider !== "google" || body.idToken || body.scopes || body.additionalParams || body.additionalData || body.requestSignUp) {
        return apiError(422, "INVALID_INPUT", "Google 로그인 요청을 확인해주세요.");
      }
      // Fixed callback destinations. Never accept a client-supplied redirect or token.
      let initialTimezone = "UTC";
      try { initialTimezone = timezone(body.timezone); } catch { /* A device suggestion is optional. */ }
      request = new Request(request.url, { method: "POST", headers: request.headers,
        body: JSON.stringify({ provider: "google", callbackURL: "/", errorCallbackURL: "/?auth=error", disableRedirect: true, additionalData: { initialTimezone } }) });
    }
    const result = await auth.handler(request);
    if (result.status >= 500) return apiError(503, "AUTH_UNAVAILABLE", "로그인 연결을 확인할 수 없습니다.");
    const destination = result.headers.get("location");
    if (destination && new URL(destination, config.baseUrl).searchParams.has("error")) {
      result.headers.set("Location", `${config.baseUrl}/?auth=error`);
    }
    result.headers.set("Cache-Control", "no-store");
    return result;
  } catch {
    return apiError(503, "AUTH_UNAVAILABLE", "로그인 연결을 준비 중입니다. 잠시 후 다시 시도해주세요.");
  }
}
export const GET = handle;
export const POST = handle;
