"use client";

import { Temporal } from "@js-temporal/polyfill";
import { useEffect, useId, useRef, useState } from "react";

const weekdays = ["월", "화", "수", "목", "금", "토", "일"];

export function calendarMonthDays(date: string): (string | null)[] {
  const first = Temporal.PlainDate.from(date).with({ day: 1 });
  const offset = first.dayOfWeek - 1;
  return Array.from({ length: Math.ceil((offset + first.daysInMonth) / 7) * 7 }, (_, index) => {
    const day = index - offset + 1;
    return day < 1 || day > first.daysInMonth ? null : first.with({ day }).toString();
  });
}

export function DiaryCalendar({ date, today, disabled, onSelect }: {
  date: string;
  today: string;
  disabled: boolean;
  onSelect: (date: string) => void;
}) {
  const [month, setMonth] = useState(() => Temporal.PlainDate.from(date).with({ day: 1 }).toString());
  const headingId = useId();
  useEffect(() => { setMonth(Temporal.PlainDate.from(date).with({ day: 1 }).toString()); }, [date]);
  const first = Temporal.PlainDate.from(month);
  const previousDisabled = disabled || (first.year === 1 && first.month === 1);
  const nextDisabled = disabled || (first.year === 9999 && first.month === 12);
  return <section className="diary-calendar" aria-labelledby={headingId}>
    <div className="calendar-month">
      <h2 id={headingId}>{first.year}년 {first.month}월</h2>
      <div>
        <button className="calendar-arrow" type="button" aria-label="이전 달" disabled={previousDisabled} onClick={() => setMonth(first.subtract({ months: 1 }).toString())}><span aria-hidden="true">‹</span></button>
        <button className="calendar-arrow" type="button" aria-label="다음 달" disabled={nextDisabled} onClick={() => setMonth(first.add({ months: 1 }).toString())}><span aria-hidden="true">›</span></button>
      </div>
    </div>
    <div className="calendar-weekdays" aria-hidden="true">{weekdays.map(day => <span key={day}>{day}</span>)}</div>
    <div className="calendar-days">{calendarMonthDays(month).map((value, index) => {
      const cellDate = first.add({ days: index - first.dayOfWeek + 1 }).toString();
      if (!value) return <span key={cellDate} aria-hidden="true" />;
      const day = Temporal.PlainDate.from(value);
      return <button type="button" key={value} className={`calendar-day${value === date ? " is-selected" : ""}${value === today ? " is-today" : ""}`}
        aria-label={`${day.day}, ${day.year}년 ${day.month}월 ${day.day}일`} aria-pressed={value === date} aria-current={value === today ? "date" : undefined}
        disabled={disabled} onClick={() => onSelect(value)}>{day.day}</button>;
    })}</div>
    <button type="button" className="calendar-today" disabled={disabled} onClick={() => { setMonth(Temporal.PlainDate.from(today).with({ day: 1 }).toString()); onSelect(today); }}>오늘로 돌아가기</button>
  </section>;
}

export function DiaryDatePicker({ date, today, disabled, onSelect }: {
  date: string;
  today: string;
  disabled: boolean;
  onSelect: (date: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const dialogId = useId();
  return <div className="diary-date-picker">
    <button type="button" className="date-picker-trigger" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-controls={dialogId}
      onClick={() => { dialog.current?.showModal(); setOpen(true); }}>날짜 선택</button>
    <dialog ref={dialog} id={dialogId} className="diary-date-dialog" aria-label="날짜 선택" onClose={() => setOpen(false)}>
      <div className="date-dialog-heading"><p>날짜를 골라 페이지를 펼치세요</p><button type="button" className="quiet-button" onClick={() => dialog.current?.close()} aria-label="달력 닫기">닫기</button></div>
      <DiaryCalendar date={date} today={today} disabled={disabled} onSelect={value => { onSelect(value); dialog.current?.close(); }} />
    </dialog>
  </div>;
}
