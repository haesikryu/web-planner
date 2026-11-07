"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeScheduleSlots, SCHEDULE_START, SCHEDULE_END, SCHEDULE_STEP, type ScheduleEntry, type ScheduleSlot } from "@/domain/schedule";
import type { PlannerSession } from "./planner";

type Draft = { entry: ScheduleEntry; slots: ScheduleSlot[]; loaded: boolean; loading: boolean; error: string; message: string };
type Pending = { owner: string; date: string; slots: ScheduleSlot[]; version: number; key: string; startedAt: number };
export type ScheduleState = { dirty: boolean; busy: boolean; pending: boolean; pendingDate: string | null };
type Props = {
  date: string; ownerId: string; disabled: boolean; demo: boolean;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  verifySession: () => Promise<PlannerSession>;
  onStateChange: (state: ScheduleState) => void;
};
const blank = (date: string): Draft => ({ entry: { date, slots: [], version: 0, updatedAt: null }, slots: [], loaded: false, loading: false, error: "", message: "일정을 불러오는 중입니다." });

const minutes = Array.from({ length: (SCHEDULE_END - SCHEDULE_START) / SCHEDULE_STEP }, (_, index) => SCHEDULE_START + index * SCHEDULE_STEP);
const slotsPerPage = 4;
const schedulePages = Array.from({ length: minutes.length / slotsPerPage }, (_, index) => index);
const clockTime = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const sameSlots = (first: ScheduleSlot[], second: ScheduleSlot[]) => first.length === second.length && first.every((slot, index) => slot.startMinute === second[index].startMinute && slot.title === second[index].title);

export function ScheduleEditor({ date, ownerId, disabled, demo, request, verifySession, onStateChange }: Props) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false), [pending, setPending] = useState<Pending | null>(null);
  const [conflict, setConflict] = useState<ScheduleEntry | null>(null);
  const [timePage, setTimePage] = useState(0);
  const draftsRef = useRef(drafts), ownerRef = useRef(ownerId), sequences = useRef<Record<string, number>>({});
  const cacheOwner = useRef(ownerId), operation = useRef(false);
  draftsRef.current = drafts; ownerRef.current = ownerId;
  const page = ownerId && cacheOwner.current === ownerId ? drafts[date] ?? blank(date) : blank(date);
  const dirty = page.loaded && !sameSlots(page.slots, page.entry.slots);
  const update = useCallback((day: string, change: Partial<Draft>) => {
    setDrafts(old => ({ ...old, [day]: { ...(old[day] ?? blank(day)), ...change } }));
  }, []);
  const read = useCallback(async (day: string, owner: string): Promise<ScheduleEntry> => {
    const before = await verifySession();
    if (before.userId !== owner || ownerRef.current !== owner) throw new Error("계정이 변경되었습니다.");
    const response = await request(`/api/schedule/${day}`, { cache: "no-store" });
    const after = await verifySession();
    if (after.userId !== owner || ownerRef.current !== owner) throw new Error("계정이 변경되었습니다.");
    if (!response.ok) throw new Error("일정을 불러오지 못했습니다. 다시 시도해주세요.");
    return response.json();
  }, [request, verifySession]);
  const load = useCallback(async (day: string, owner: string) => {
    const sequence = (sequences.current[day] ?? 0) + 1;
    sequences.current[day] = sequence;
    update(day, { loading: true, error: "", message: "일정을 불러오는 중입니다." });
    try {
      const entry = await read(day, owner);
      if (ownerRef.current !== owner || sequences.current[day] !== sequence) return;
      update(day, { entry, slots: entry.slots, loaded: true, loading: false, message: entry.version ? "저장된 일정입니다." : "시간 옆에 오늘의 일정을 적어보세요." });
    } catch (cause) {
      if (ownerRef.current === owner && sequences.current[day] === sequence) update(day, { loading: false, error: cause instanceof Error ? cause.message : "일정을 불러오지 못했습니다.", message: "일정 불러오기 확인 필요" });
    }
  }, [read, update]);
  useEffect(() => {
    if (cacheOwner.current === ownerId) return;
    cacheOwner.current = ownerId; draftsRef.current = {}; operation.current = false;
    setDrafts({}); setPending(null); setConflict(null); setBusy(false);
  }, [ownerId]);
  useEffect(() => {
    setTimePage(0);
    if (!ownerId) return;
    const cached = draftsRef.current[date];
    if (cached?.loaded && !sameSlots(cached.slots, cached.entry.slots)) return;
    void load(date, ownerId);
  }, [date, ownerId, load]);
  useEffect(() => {
    onStateChange({ dirty: Boolean(ownerId) && Object.values(drafts).some(value => value.loaded && !sameSlots(value.slots, value.entry.slots)), busy, pending: Boolean(pending), pendingDate: pending?.date ?? null });
  }, [drafts, busy, pending, ownerId, onStateChange]);

  async function send(value: Pending) {
    if (operation.current || busy || disabled || ownerRef.current !== value.owner) return;
    if (Date.now() - value.startedAt >= 86400000) { update(value.date, { error: "24시간이 지난 요청입니다. 저장 여부를 확인한 뒤 다시 저장해주세요." }); return; }
    operation.current = true; setBusy(true); setPending(value); setConflict(null);
    update(value.date, { error: "", message: "일정을 저장하는 중입니다." });
    try {
      const session = await verifySession();
      if (session.userId !== value.owner || ownerRef.current !== value.owner) return;
      const response = await request(`/api/schedule/${value.date}`, { method: "PUT", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken,
        "Idempotency-Key": value.key, "If-Match": `"v${value.version}"` }, body: JSON.stringify({ slots: value.slots }) });
      if (response.status === 412) {
        const latest = await read(value.date, value.owner);
        if (ownerRef.current !== value.owner) return;
        setConflict(latest); update(value.date, { error: "다른 곳에서 일정이 변경되었습니다. 저장된 일정과 내 일정을 비교해주세요.", message: "일정 충돌 확인 필요" }); return;
      }
      if (!response.ok) {
        if ([400, 422, 428].includes(response.status)) setPending(null);
        throw new Error("일정의 저장을 확인할 수 없습니다. 입력을 보존했습니다.");
      }
      const latest = await read(value.date, value.owner);
      if (ownerRef.current !== value.owner) return;
      if (!sameSlots(latest.slots, value.slots)) {
        setConflict(latest); update(value.date, { error: "저장 후 다른 곳에서 일정이 변경되었습니다. 내 일정을 보존했습니다.", message: "일정 충돌 확인 필요" }); return;
      }
      update(value.date, { entry: latest, slots: latest.slots, loaded: true, error: "", message: "일정을 저장했습니다." });
      setPending(null); setConflict(null);
    } catch (cause) {
      if (ownerRef.current === value.owner) update(value.date, { error: cause instanceof Error && !(cause instanceof TypeError) ? cause.message : "연결을 확인해주세요. 작성한 일정과 저장 요청을 보존했습니다.", message: "일정 저장 확인 필요" });
    } finally { if (ownerRef.current === value.owner) { operation.current = false; setBusy(false); } }
  }
  async function confirmSaved() {
    if (!pending || operation.current || busy || disabled) return;
    const value = pending; operation.current = true; setBusy(true);
    try {
      const latest = await read(value.date, value.owner);
      if (ownerRef.current !== value.owner) return;
      if (sameSlots(latest.slots, value.slots)) {
        update(value.date, { entry: latest, slots: latest.slots, loaded: true, error: "", message: "일정을 저장했습니다." }); setPending(null); setConflict(null);
      } else { setConflict(latest); update(value.date, { error: "저장된 일정과 내 일정이 다릅니다. 사용할 일정을 선택해주세요.", message: "일정 확인 필요" }); }
    } catch { if (ownerRef.current === value.owner) update(value.date, { error: "저장 여부를 확인하지 못했습니다. 작성한 일정을 보존했습니다." }); }
    finally { if (ownerRef.current === value.owner) { operation.current = false; setBusy(false); } }
  }
  let validation = "";
  let normalized: ScheduleSlot[] = [];
  try { normalized = normalizeScheduleSlots(page.slots.filter(slot => slot.title.trim())); }
  catch { validation = "각 일정은 줄바꿈 없이 200자 이내로 입력해주세요."; }
  const inputDisabled = disabled || busy || Boolean(pending) || !page.loaded || page.loading || !ownerId;
  return <section className="schedule-section" id="diary-schedule" aria-label="하루 일정">
    <div className="section-heading"><h2>하루 일정</h2><span className="schedule-range">06:00 — 24:00</span></div>
    <p id="schedule-help" className="field-note">30분마다 한 칸, 시간대를 바꾸어 하루 일정을 확인하세요.</p>
    <div className="schedule-pagination">
      <button type="button" aria-label="이전 시간대" disabled={timePage === 0} onClick={() => setTimePage(value => value - 1)}>‹</button>
      <label className="sr-only" htmlFor="schedule-time-page">일정 시간대</label>
      <select id="schedule-time-page" value={timePage} onChange={event => setTimePage(Number(event.target.value))}>
        {schedulePages.map(index => <option key={index} value={index}>{clockTime(SCHEDULE_START + index * slotsPerPage * SCHEDULE_STEP)}–{clockTime(SCHEDULE_START + (index + 1) * slotsPerPage * SCHEDULE_STEP)}</option>)}
      </select>
      <span className="schedule-page-count">{timePage + 1} / {schedulePages.length}</span>
      <button type="button" aria-label="다음 시간대" disabled={timePage === schedulePages.length - 1} onClick={() => setTimePage(value => value + 1)}>›</button>
    </div>
    <form onSubmit={event => {
      event.preventDefault(); if (inputDisabled || !dirty || validation) return;
      void send({ owner: ownerId, date, slots: normalized, version: page.entry.version, key: crypto.randomUUID(), startedAt: Date.now() });
    }}>
      <fieldset className="schedule-grid" aria-label="30분 단위 일정표" aria-describedby="schedule-help">
        {minutes.slice(timePage * slotsPerPage, (timePage + 1) * slotsPerPage).map(minute => <div className={`schedule-row${minute % 60 ? " half-hour" : ""}`} key={minute}>
          <label htmlFor={`schedule-${minute}`}><span>{clockTime(minute)}</span><span className="schedule-until">–{clockTime(minute + SCHEDULE_STEP)}</span></label>
          <input id={`schedule-${minute}`} aria-label={`${clockTime(minute)} 일정`} value={page.slots.find(slot => slot.startMinute === minute)?.title ?? ""}
            disabled={inputDisabled} autoComplete="off" placeholder="일정 입력" onChange={event => {
              const slots = page.slots.filter(slot => slot.startMinute !== minute);
              if (event.target.value) slots.push({ startMinute: minute, title: event.target.value });
              slots.sort((a, b) => a.startMinute - b.startMinute);
              update(date, { slots, error: "", message: "저장하지 않은 일정이 있습니다." });
            }} />
        </div>)}
      </fieldset>
      <div className="schedule-actions"><span className="schedule-count">{normalized.length} / 36칸</span><button type="submit" disabled={inputDisabled || !dirty || Boolean(validation)}>일정 저장</button></div>
      <p className="field-note">모든 시간대의 변경을 함께 저장해요.{demo ? " 이 탭에 임시 저장됩니다." : ""}</p>
    </form>
    <p className="schedule-save-status" aria-live="polite">{page.message}</p>
    {validation && <p role="alert" className="error-note">{validation}</p>}
    {page.error && <p role="alert" className="error-note">{page.error}</p>}
    {!page.loaded && !page.loading && ownerId && <button type="button" disabled={disabled || busy} onClick={() => void load(date, ownerId)}>일정 다시 불러오기</button>}
    {ownerId && pending && !busy && !conflict && <div className="journal-recovery"><button type="button" disabled={disabled} onClick={() => void send(pending)}>같은 일정 다시 저장</button><button type="button" disabled={disabled} onClick={() => void confirmSaved()}>일정 저장 여부 확인</button></div>}
    {ownerId && pending && conflict && <section className="journal-recovery" aria-label="일정 충돌 확인"><h3>저장된 일정</h3>
      {conflict.slots.length ? <ul>{conflict.slots.map(slot => <li key={slot.startMinute}>{clockTime(slot.startMinute)} — {slot.title}</li>)}</ul> : <p>(빈 일정)</p>}<p>작성한 내 일정은 위 입력란에 보존했습니다.</p>
      <button type="button" disabled={disabled || busy} onClick={() => { update(pending.date, { entry: conflict, slots: conflict.slots, error: "", message: "저장된 일정을 불러왔습니다." }); setPending(null); setConflict(null); }}>저장된 일정 사용</button>
      <button type="button" disabled={disabled || busy} onClick={() => void send({ ...pending, version: conflict.version, key: crypto.randomUUID(), startedAt: Date.now() })}>내 일정 다시 저장</button></section>}
  </section>;
}
