import { describe, expect, it } from "vitest";
import { ConfigurationError, readAuthConfiguration } from "../../src/server/config";

const valid = {
  AUTH_ALLOWED_EMAILS: "owner@example.test",
  BETTER_AUTH_URL: "http://localhost:3000",
  DATABASE_URL: "postgresql://synthetic:synthetic@localhost:54329/test",
  BETTER_AUTH_SECRET: "synthetic-test-value-never-use-in-production",
  GOOGLE_CLIENT_ID: "synthetic-client",
  GOOGLE_CLIENT_SECRET: "synthetic-provider-value"
};

describe("server authentication configuration boundary", () => {
  it.each(["", "*", "*@example.test", "owner@example.test,"])("fails closed on missing or invalid private beta allowlist %s", value => {
    expect(() => readAuthConfiguration({ ...valid, AUTH_ALLOWED_EMAILS: value }, false)).toThrow(ConfigurationError);
  });
  it("normalizes explicit email addresses without alias expansion", () => {
    expect(readAuthConfiguration({ ...valid, AUTH_ALLOWED_EMAILS: " Owner+beta@Example.test,owner+beta@example.test " }, false).allowedEmails).toEqual(["owner+beta@example.test"]);
  });
  it("allows loopback HTTP only for local development", () => {
    expect(readAuthConfiguration(valid, false).baseUrl).toBe("http://localhost:3000");
    expect(() => readAuthConfiguration(valid, true)).toThrow(ConfigurationError);
  });
  it("accepts an explicit HTTPS production origin", () => {
    expect(readAuthConfiguration({ ...valid, BETTER_AUTH_URL: "https://planner.example/" }, true).baseUrl)
      .toBe("https://planner.example");
  });
  it.each(["http://planner.example", "https://user:pass@planner.example", "https://planner.example/path", "https://planner.example/?token=private", "javascript:alert(1)"])("rejects unsafe base URL %s", url => {
    expect(() => readAuthConfiguration({ ...valid, BETTER_AUTH_URL: url }, false)).toThrow(ConfigurationError);
  });
  it("fails closed when Google credentials are absent", () => {
    expect(() => readAuthConfiguration({ ...valid, GOOGLE_CLIENT_SECRET: "" }, false)).toThrow(ConfigurationError);
  });
  it("does not disclose supplied secrets in configuration errors", () => {
    try {
      readAuthConfiguration({ ...valid, BETTER_AUTH_SECRET: "private-secret" }, false);
      throw new Error("expected configuration rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).not.toContain("private-secret");
      expect((error as Error).message).not.toContain(valid.DATABASE_URL);
    }
  });
  it("rejects a non-PostgreSQL database URL", () => {
    expect(() => readAuthConfiguration({ ...valid, DATABASE_URL: "https://db.example" }, false)).toThrow(ConfigurationError);
  });
});
