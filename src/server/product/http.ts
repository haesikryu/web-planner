import { InputError, uuidPattern } from "../../domain/rules";
import { getAuthRuntime } from "../auth/runtime";
import { resolveSession } from "../auth/session";
import { apiError, csrfToken, privateHeaders, validCsrf, validOrigin } from "../auth/security";

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
export type Actor = { id: string; timezone: string; secret: string };
export async function authenticated(request: Request, write: boolean, action: (actor: Actor) => Promise<Response>): Promise<Response> {
  if (!request.headers.get("cookie")) return apiError(401, "UNAUTHENTICATED", "로그인이 필요합니다.");
  try {
    const current = await resolveSession(request.headers);
    if (!current) return apiError(401, "UNAUTHENTICATED", "로그인이 필요합니다.");
    const { config } = getAuthRuntime();
    if (write && (!validOrigin(request, config.baseUrl) || !validCsrf(request.headers.get("x-csrf-token"), csrfToken(current.session.id, config.secret)))) {
      return apiError(403, "FORBIDDEN", "요청을 다시 확인해주세요.");
    }
    return await action({ id: current.user.id, timezone: current.user.timezone ?? "UTC", secret: config.secret });
  } catch (error) {
    if (error instanceof InputError) return apiError(422, "INVALID_INPUT", `${error.field} 값을 확인해주세요.`);
    if (error instanceof HttpError) {
      const response = apiError(error.status, error.code, error.message);
      if (error.code === "REQUEST_IN_PROGRESS") response.headers.set("Retry-After", "1");
      return response;
    }
    return apiError(500, "INTERNAL_ERROR", "처리를 확인할 수 없습니다. 같은 요청으로 다시 시도해주세요.");
  }
}
export async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new InputError("content-type");
  // Bounded stream: do not allocate an unbounded body before validating it.
  const reader = request.body?.getReader();
  if (!reader) throw new InputError("body");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 16384) { await reader.cancel(); throw new InputError("body"); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new InputError("body"); }
}
export function requestKey(request: Request): string {
  const value = request.headers.get("idempotency-key");
  if (!value || !uuidPattern.test(value)) throw new InputError("Idempotency-Key");
  return value.toLowerCase();
}
export function expectedVersion(request: Request): number {
  const value = request.headers.get("if-match");
  if (!value) throw new HttpError(428, "PRECONDITION_REQUIRED", "최신 버전이 필요합니다.");
  if (!/^"v[1-9][0-9]*"$/u.test(value)) throw new InputError("If-Match");
  const result = Number(value.slice(2, -1));
  if (!Number.isSafeInteger(result) || result > 2147483646) throw new InputError("If-Match");
  return result;
}
export const etag = (version: number) => `"v${version}"`;
export type SavedResponse = { status: number; body: unknown; etag?: string };
export function respond(value: SavedResponse): Response {
  return Response.json(value.body, { status: value.status, headers: { ...privateHeaders, ...(value.etag ? { ETag: value.etag } : {}) } });
}
