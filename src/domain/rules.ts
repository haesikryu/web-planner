import { Temporal } from "@js-temporal/polyfill";

export class InputError extends Error {
  constructor(public readonly field: string) { super(`Invalid ${field}`); }
}
export function title(value: unknown): string {
  if (typeof value !== "string" || /[\r\n\0]/u.test(value)) throw new InputError("title");
  const normalized = value.normalize("NFC").trim();
  if (![...normalized].length || [...normalized].length > 200) throw new InputError("title");
  return normalized;
}
export function timezone(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 100 || /^[+-]/u.test(value)) throw new InputError("timezone");
  try { return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone; }
  catch { throw new InputError("timezone"); }
}
export function calendarDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || value.startsWith("0000")) throw new InputError("date");
  try { return Temporal.PlainDate.from(value, { overflow: "reject" }).toString(); }
  catch { throw new InputError("date"); }
}
export function today(zone: string, now = new Date()): string {
  return Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(timezone(zone)).toPlainDate().toString();
}
export function dayRange(value: string, zone: string): { start: Date; end: Date } {
  const date = Temporal.PlainDate.from(calendarDate(value)), timeZone = timezone(zone);
  const start = date.toZonedDateTime(timeZone).startOfDay();
  // Use the next calendar day's boundary, including midnight transitions and skipped days.
  const end = date.add({ days: 1 }).toZonedDateTime(timeZone).startOfDay();
  return { start: new Date(start.epochMilliseconds), end: new Date(end.epochMilliseconds) };
}
export function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new InputError("body");
  return value as Record<string, unknown>;
}
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
