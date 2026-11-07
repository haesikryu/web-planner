import { isLoginEnabled } from "./config";

export function isLocalDemoEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.NODE_ENV === "development" && env.LOCAL_DEMO_ENABLED === "true" && !isLoginEnabled(env);
}
