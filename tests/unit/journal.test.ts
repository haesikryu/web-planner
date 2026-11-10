import { describe, expect, it } from "vitest";
import { journalContent, JOURNAL_MAX_LENGTH } from "../../src/domain/journal";
import { expectedVersion, readJson } from "../../src/server/product/http";

describe("journal content and request boundaries", () => {
  it("keeps empty text, whitespace and decomposed Unicode, normalizing only CRLF", () => {
    expect(journalContent("")).toBe("");
    expect(journalContent("  e\u0301\r\n😀\r끝\n ")).toBe("  e\u0301\n😀\r끝\n ");
    expect(journalContent("😀".repeat(JOURNAL_MAX_LENGTH))).toHaveLength(JOURNAL_MAX_LENGTH * 2);
    expect(journalContent("\r\n".repeat(JOURNAL_MAX_LENGTH))).toBe("\n".repeat(JOURNAL_MAX_LENGTH));
  });
  it.each([null, undefined, 1, {}, "text\0", "😀".repeat(JOURNAL_MAX_LENGTH + 1)])("rejects invalid journal content %#", value => {
    expect(() => journalContent(value)).toThrow("Invalid content");
  });
  it("keeps the existing request body limit unless a route explicitly increases it", async () => {
    const content = "가".repeat(6000);
    const request = () => new Request("https://planner.example", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
    await expect(readJson(request())).rejects.toThrow("Invalid body");
    await expect(readJson(request(), 65536)).resolves.toEqual({ content });
  });
  it("allows version zero only for the journal route and rejects noncanonical zero", () => {
    const request = (version: string) => new Request("https://planner.example", { headers: { "if-match": version } });
    expect(() => expectedVersion(request('"v0"'))).toThrow("Invalid If-Match");
    expect(expectedVersion(request('"v0"'), true)).toBe(0);
    expect(() => expectedVersion(request('"v00"'), true)).toThrow("Invalid If-Match");
    expect(expectedVersion(request('"v1"'))).toBe(1);
  });
});
