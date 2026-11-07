import { expect, it } from "vitest";
import { isLocalDemoEnabled } from "../../src/server/demo";

it("only offers browser demo when explicitly enabled in development with login paused", () => {
  const enabled = { NODE_ENV: "development", LOCAL_DEMO_ENABLED: "true", AUTH_LOGIN_ENABLED: "false" };
  expect(isLocalDemoEnabled(enabled)).toBe(true);
  expect(isLocalDemoEnabled({ ...enabled, NODE_ENV: "production" })).toBe(false);
  expect(isLocalDemoEnabled({ ...enabled, NODE_ENV: "test" })).toBe(false);
  expect(isLocalDemoEnabled({ ...enabled, LOCAL_DEMO_ENABLED: undefined })).toBe(false);
  expect(isLocalDemoEnabled({ ...enabled, AUTH_LOGIN_ENABLED: "true" })).toBe(false);
  expect(isLocalDemoEnabled({})).toBe(false);
});
