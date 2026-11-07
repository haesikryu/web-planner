import { createHash } from "node:crypto";
import type { DBAdapter, DBTransactionAdapter, Where } from "better-auth/adapters";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const sensitiveFields = ["accessToken", "refreshToken", "idToken", "password"];
type Operation = { model: string; where?: Where[]; data?: Record<string, unknown>; update?: Record<string, unknown>; set?: Record<string, unknown> };

/** Wrap the library adapter, including transaction adapters; never persist bearer tokens. */
export function protectStorage<T extends DBAdapter | DBTransactionAdapter>(adapter: T): T {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      const original = Reflect.get(target, property, receiver);
      if (typeof original !== "function") return original;
      if (property === "transaction") return (callback: (tx: DBTransactionAdapter) => Promise<unknown>) =>
        original.call(target, (tx: DBTransactionAdapter) => callback(protectStorage(tx)));
      return async (input: Operation) => {
        if (!input || !["session", "account"].includes(input.model)) return original.call(target, input);
        const originals = new Map<string, string>();
        const encode = (value: unknown): unknown => {
          if (Array.isArray(value)) return value.map(encode);
          if (typeof value !== "string") throw new Error("Invalid session token operation");
          const digest = hashToken(value); originals.set(digest, value); return digest;
        };
        const fields = (record: Record<string, unknown> | undefined) => {
          if (!record) return record;
          const result = { ...record };
          if (input.model === "session" && typeof result.token === "string") result.token = encode(result.token);
          if (input.model === "account") for (const field of sensitiveFields) if (field in result) result[field] = null;
          return result;
        };
        const where = input.where?.map(item => {
          if (input.model !== "session" || item.field !== "token") return item;
          if (item.operator && !["eq", "in"].includes(item.operator)) throw new Error("Unsupported token comparison");
          return { ...item, value: encode(item.value) as Where["value"] };
        });
        const result: unknown = await original.call(target, { ...input, where, data: fields(input.data), update: fields(input.update), set: fields(input.set) });
        const restore = (row: unknown): unknown => {
          if (!row || typeof row !== "object") return row;
          if (Array.isArray(row)) return row.map(restore);
          const record = row as Record<string, unknown>;
          // By-user session listing has no bearer token to restore. Its digest is never a usable credential.
          return input.model === "session" && typeof record.token === "string"
            ? { ...record, token: originals.get(record.token) ?? record.token } : record;
        };
        return restore(result);
      };
    }
  });
}
