import { expect, it } from "vitest";
import { calendarMonthDays } from "../../src/app/diary-calendar";

it("places leap day in a Monday-first February calendar without adjacent month dates", () => {
  const days = calendarMonthDays("2024-02-29");
  expect(days).toHaveLength(35);
  expect(days.slice(0, 4)).toEqual([null, null, null, "2024-02-01"]);
  expect(days.filter(Boolean)).toHaveLength(29);
  expect(days[31]).toBe("2024-02-29");
  expect(days.slice(32)).toEqual([null, null, null]);
});

it("keeps a Sunday-starting month aligned through its sixth week", () => {
  const days = calendarMonthDays("2026-11-07");
  expect(days).toHaveLength(42);
  expect(days.slice(0, 6)).toEqual([null, null, null, null, null, null]);
  expect(days[6]).toBe("2026-11-01");
  expect(days[35]).toBe("2026-11-30");
  expect(days.filter(Boolean)).toHaveLength(30);
});
