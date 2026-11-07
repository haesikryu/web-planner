import { createHmac, timingSafeEqual } from "node:crypto";

export function csrfToken(sessionId: string, secret: string): string {
  return createHmac("sha256", secret).update(`planner:csrf:v1:${sessionId}`).digest("base64url");
}
export function validCsrf(value: string | null, expected: string): boolean {
  if (!value) return false;
  const actualBytes = Buffer.from(value), expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
export function validOrigin(request: Request, baseUrl: string): boolean {
  return request.headers.get("origin") === baseUrl && request.headers.get("sec-fetch-site") !== "cross-site";
}
export const privateHeaders = { "Cache-Control": "no-store", "Vary": "Cookie" };
export function apiError(status: number, code: string, message: string): Response {
  return Response.json({ code, message, requestId: crypto.randomUUID() }, { status, headers: privateHeaders });
}
