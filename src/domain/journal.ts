import { InputError } from "./rules";

export const JOURNAL_MAX_LENGTH = 10000;
export type JournalEntry = { date: string; content: string; version: number; updatedAt: string | null };

export function journalContent(value: unknown): string {
  if (typeof value !== "string" || value.includes("\0")) throw new InputError("content");
  const normalized = value.replaceAll("\r\n", "\n");
  if ([...normalized].length > JOURNAL_MAX_LENGTH) throw new InputError("content");
  return normalized;
}
