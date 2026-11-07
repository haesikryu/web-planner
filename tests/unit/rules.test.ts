import { describe, expect, it } from "vitest";
import { calendarDate, dayRange, InputError, timezone, title, today } from "../../src/domain/rules";

describe("title and account calendar rules", () => {
  it("normalizes NFC, trims Unicode edges, preserves internal space and counts code points", () => {
    expect(title("\u00a0 e\u0301  할 일 \u3000")).toBe("é  할 일");
    expect(title("😀".repeat(200))).toHaveLength(400);
    expect(() => title("😀".repeat(201))).toThrow(InputError);
    for (const value of ["", "\u3000\u00a0", "x\ny", "x\ry", "x\0y", null]) expect(() => title(value)).toThrow(InputError);
  });
  it("rejects non-calendar dates without silently rolling into another month", () => {
    expect(calendarDate("2024-02-29")).toBe("2024-02-29");
    for (const value of ["2025-02-29", "2026-04-31", "2026-1-01", "0000-01-01", "2026-11-07T00:00:00Z"]) expect(() => calendarDate(value)).toThrow(InputError);
  });
  it("validates named time zones and uses server instants independently of device zone", () => {
    expect(timezone("Asia/Seoul")).toBe("Asia/Seoul");
    for (const value of ["Mars/Base", "+09:00", "", null]) expect(() => timezone(value)).toThrow(InputError);
    const now = new Date("2026-11-06T15:30:00Z");
    expect(today("Asia/Seoul", now)).toBe("2026-11-07");
    expect(today("UTC", now)).toBe("2026-11-06");
  });
  it("computes 23/25-hour DST days and midnight transitions", () => {
    for (const [date, hours] of [["2026-03-08", 23], ["2026-11-01", 25]] as const) {
      const { start, end } = dayRange(date, "America/New_York");
      expect((end.getTime() - start.getTime()) / 3600000).toBe(hours);
      expect(today("America/New_York", start)).toBe(date);
      expect(today("America/New_York", new Date(end.getTime() - 1))).toBe(date);
    }
    const midnight = dayRange("2018-11-04", "America/Sao_Paulo");
    expect(midnight.start.toISOString()).toBe("2018-11-04T03:00:00.000Z");
    const skipped = dayRange("2011-12-30", "Pacific/Apia");
    expect(skipped.start.getTime()).toBe(skipped.end.getTime());
  });
});
