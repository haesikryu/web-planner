import { describe, expect, it } from "vitest";
import { normalizeScheduleSlots, SCHEDULE_END, SCHEDULE_START, SCHEDULE_STEP } from "../../src/domain/schedule";

describe("half-hour schedule normalization", () => {
  it("normalizes titles and sorts a new array without mutating input", () => {
    const source = [{ startMinute: 1410, title: "  e\u0301 끝  " }, { startMinute: 360, title: "시작" }];
    expect(normalizeScheduleSlots(source)).toEqual([{ startMinute: 360, title: "시작" }, { startMinute: 1410, title: "é 끝" }]);
    expect(source[0].title).toBe("  e\u0301 끝  ");
    expect(normalizeScheduleSlots([])).toEqual([]);
  });
  it("allows all 36 slots and Unicode titles up to 200 code points", () => {
    const slots = Array.from({ length: (SCHEDULE_END - SCHEDULE_START) / SCHEDULE_STEP }, (_, i) => ({ startMinute: SCHEDULE_START + i * SCHEDULE_STEP, title: "😀".repeat(200) }));
    expect(normalizeScheduleSlots(slots)).toEqual(slots);
    expect(slots).toHaveLength(36);
  });
  it.each([null, {}, [{ startMinute: 330, title: "early" }], [{ startMinute: 1440, title: "late" }], [{ startMinute: 361, title: "offset" }], [{ startMinute: 360.5, title: "fraction" }], [{ startMinute: "360", title: "string" }], [{ startMinute: 360, title: " " }], [{ startMinute: 360, title: "line\nbreak" }], [{ startMinute: 360, title: "NUL\0" }], [{ startMinute: 360, title: "x".repeat(201) }], [{ startMinute: 360, title: "extra", ownerId: "other" }], [{ startMinute: 360, title: "first" }, { startMinute: 360, title: "duplicate" }], Array.from({ length: 37 }, () => ({ startMinute: 360, title: "too many" }))])("rejects invalid slot documents %#", value => {
    expect(() => normalizeScheduleSlots(value)).toThrow();
  });
});
