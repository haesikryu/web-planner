import { describe, expect, it } from "vitest";
import { csrfToken, validCsrf, validOrigin } from "../../src/server/auth/security";

describe("session-bound request protection", () => {
  it("binds CSRF proof to both session and server secret", () => {
    const value = csrfToken("session-a", "test-secret");
    expect(validCsrf(value, value)).toBe(true);
    expect(validCsrf(value, csrfToken("session-b", "test-secret"))).toBe(false);
    expect(validCsrf(value, csrfToken("session-a", "another-secret"))).toBe(false);
    expect(validCsrf(null, value)).toBe(false);
    expect(validCsrf("x".repeat(value.length), value)).toBe(false);
    expect(validCsrf("한".repeat(value.length), value)).toBe(false);
  });
  it("requires exact origin and rejects cross-site requests", () => {
    const request = (origin?: string, site?: string) => new Request("https://planner.example/api/logout", {
      headers: { ...(origin ? { origin } : {}), ...(site ? { "sec-fetch-site": site } : {}) }
    });
    expect(validOrigin(request("https://planner.example"), "https://planner.example")).toBe(true);
    expect(validOrigin(request(), "https://planner.example")).toBe(false);
    expect(validOrigin(request("https://planner.example.attacker.test"), "https://planner.example")).toBe(false);
    expect(validOrigin(request("https://planner.example", "cross-site"), "https://planner.example")).toBe(false);
  });
});
