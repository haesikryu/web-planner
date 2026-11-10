"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Temporal } from "@js-temporal/polyfill";
import type { TaskStatus } from "@/domain/task-options";
import { DiaryDatePicker } from "./diary-calendar";
import { PlannerDay, type DayState } from "./planner-day";

export type PlannerSession = { userId: string; timezone: string; settingsVersion: number; serverDate: string; csrfToken: string };
export type PlannerTask = { id: string; title: string; status: TaskStatus; dailyOrder: number | null; scheduledDate: string | null; dueDate: string | null; isUnprocessed: boolean; version: number };
type PlannerRequest = (path: string, init?: RequestInit) => Promise<Response>;
const serverRequest: PlannerRequest = (path, init) => fetch(path, init);
const twoDayQuery = "(min-width: 700px) and (hover: hover) and (pointer: fine), (min-width: 900px) and (min-height: 600px) and (orientation: landscape)";
function subscribeLayout(change: () => void) { const query = window.matchMedia(twoDayQuery); query.addEventListener("change", change); return () => query.removeEventListener("change", change); }
const readLayout = () => window.matchMedia(twoDayQuery).matches;
const serverLayout = () => false;
function nextDay(day: string) { return day === "9999-12-31" ? null : Temporal.PlainDate.from(day).add({ days: 1 }).toString(); }
type Gate = { day: string; generation: number; offset: number };

export function Planner({ initialSession, request = serverRequest, demo = false }: { initialSession: PlannerSession; request?: PlannerRequest; demo?: boolean }) {
  const [session, setSession] = useState(initialSession);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [focusedDate, setFocusedDate] = useState(initialSession.serverDate);
  const [knownDates, setKnownDates] = useState<string[]>([initialSession.serverDate]);
  const [states, setStates] = useState<Record<string, DayState>>({});
  const [taskRevision, setTaskRevision] = useState(0);
  const onTasksChanged = useCallback(() => setTaskRevision(value => value + 1), []);
  const [authRecoveryRevision, setAuthRecoveryRevision] = useState(0);
  const authFailure = useRef(false);
  const [gate, setGate] = useState<Gate | null>(null);
  const [signingOut, setSigningOut] = useState(false), [invalidated, setInvalidated] = useState(false), [error, setError] = useState("");
  const statesRef = useRef(states), gateRef = useRef<Gate | null>(null), sessionRef = useRef(initialSession);
  const visibleDates = useRef<string[]>([initialSession.serverDate]), invalidRef = useRef(false), logoutRef = useRef(false);
  const owner = useRef(initialSession.userId);
  const twoDays = useSyncExternalStore(subscribeLayout, readLayout, serverLayout);
  const anchor = gate ? Temporal.PlainDate.from(gate.day).subtract({ days: gate.offset }).toString() : selectedDate ?? session.serverDate;
  const following = nextDay(anchor);
  const range = following ? [anchor, following] : [anchor];
  const dayCount = twoDays && following ? 2 : 1;
  const singleDate = gate?.day ?? (range.includes(focusedDate) ? focusedDate : anchor);
  const shownDates = dayCount === 2 ? range : [singleDate];
  visibleDates.current = range;
  const dates = [...new Set([...knownDates, ...shownDates])];
  const shownKey = shownDates.join(",");
  useEffect(() => {
    const visible = shownKey.split(",");
    setKnownDates(old => visible.every(day => old.includes(day)) ? old : [...new Set([...old, ...visible])]);
  }, [shownKey]);

  const onSessionFailure = useCallback((ownerId: string) => {
    if (!invalidRef.current && ownerId === owner.current) authFailure.current = true;
  }, []);
  const onSession = useCallback((fresh: PlannerSession) => {
    if (invalidRef.current) return sessionRef.current;
    if (fresh.userId !== owner.current) { invalidRef.current = true; setInvalidated(true); return fresh; }
    const old = sessionRef.current;
    if (fresh.settingsVersion < old.settingsVersion) return old;
    if (authFailure.current) { authFailure.current = false; setAuthRecoveryRevision(value => value + 1); }
    sessionRef.current = fresh;
    if (old.timezone !== fresh.timezone || old.settingsVersion !== fresh.settingsVersion || old.serverDate !== fresh.serverDate || old.csrfToken !== fresh.csrfToken) setSession(fresh);
    return fresh;
  }, []);
  const claim = useCallback((day: string, generation: number) => {
    if (invalidRef.current || logoutRef.current || (gateRef.current && gateRef.current.day !== day) || Object.entries(statesRef.current).some(([other, value]) => other !== day && value.blocked)) return false;
    const value = { day, generation, offset: gateRef.current?.offset ?? Math.max(0, visibleDates.current.indexOf(day)) };
    gateRef.current = value; setGate(value); return true;
  }, []);
  const report = useCallback((day: string, value: DayState) => {
    if (invalidRef.current || value.ownerId !== owner.current) return;
    const old = statesRef.current[day];
    statesRef.current = { ...statesRef.current, [day]: value };
    if (value.blocked && !gateRef.current) {
      const acquired = { day, generation: value.generation, offset: Math.max(0, visibleDates.current.indexOf(day)) };
      gateRef.current = acquired; setGate(acquired);
    } else if (gateRef.current?.day === day && gateRef.current.generation === value.generation) {
      if (!value.blocked) { gateRef.current = null; setGate(null); }
    }
    if (!old || Object.keys(value).some(key => old[key as keyof DayState] !== value[key as keyof DayState])) setStates(statesRef.current);
  }, []);
  const bindings = useRef<Record<string, { onClaim: (generation: number) => boolean; onStateChange: (state: DayState) => void }>>({});
  function binding(day: string) {
    if (!bindings.current[day]) bindings.current[day] = { onClaim: generation => claim(day, generation), onStateChange: state => report(day, state) };
    return bindings.current[day];
  }
  const dirty = Object.values(states).some(value => value.dirty);
  const working = signingOut || Object.values(states).some(value => value.working);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function selectDate(value: string) {
    if (gateRef.current || logoutRef.current || invalidRef.current) return;
    setSelectedDate(value === sessionRef.current.serverDate ? null : value); setFocusedDate(value); setError("");
  }
  async function signOut() {
    if (logoutRef.current || Object.values(statesRef.current).some(value => value.working)) return;
    if (Object.values(statesRef.current).some(value => value.dirty) && !window.confirm(demo ? "저장하지 않은 입력이 있습니다. 테스트를 나가면 입력을 지웁니다. 계속할까요?" : "저장하지 않은 입력이 있습니다. 로그아웃하면 입력을 지웁니다. 계속할까요?")) return;
    logoutRef.current = true; setSigningOut(true); setError("");
    try {
      const check = await request("/api/session", { cache: "no-store" });
      if (!check.ok) throw new Error("로그인 상태를 확인하지 못했습니다. 입력을 보존했습니다.");
      const fresh: PlannerSession = await check.json(); onSession(fresh);
      if (fresh.userId !== owner.current) { window.location.replace("/"); return; }
      const response = await request("/api/logout", { method: "POST", headers: { "X-CSRF-Token": fresh.csrfToken } });
      if (!response.ok) throw new Error("로그아웃을 확인하지 못했습니다. 다시 시도해주세요.");
      invalidRef.current = true; setInvalidated(true); window.location.replace("/");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "연결을 확인해주세요."); }
    finally { logoutRef.current = false; setSigningOut(false); }
  }
  const firstDate = Temporal.PlainDate.from(dayCount === 2 ? anchor : singleDate);
  const label = (day: string) => { const value = Temporal.PlainDate.from(day); return `${value.year}년 ${value.month}월 ${value.day}일`; };
  if (invalidated) return <main id="main" className="planner"><p role="status">계정을 확인하고 있습니다.</p></main>;
  return <main id="main" className="planner diary-app">
    <div className="diary-toolbar"><div><p className="eyebrow">A PAGE FOR EVERY DAY</p><p className="diary-title">나의 다이어리<span className="diary-edition">{firstDate.year} EDITION</span></p></div>
      <div className="diary-toolbar-actions"><button className="quick-entry" type="button" disabled={Boolean(gate) || signingOut} onClick={() => {
        const targetDay = shownDates.includes(focusedDate) ? focusedDate : shownDates[0];
        const panel = document.querySelector<HTMLElement>(`.planner-day[data-date="${targetDay}"]`);
        panel?.querySelector<HTMLButtonElement>('[role="tab"][data-page="plan"]')?.click();
        requestAnimationFrame(() => panel?.querySelector<HTMLInputElement>('.daily-task-row.empty input:not(:disabled)')?.focus());
      }}>＋ 빠른 입력</button><button className="quiet-button" type="button" disabled={working} onClick={() => void signOut()}>{demo ? "테스트 나가기" : "로그아웃 / 계정 바꾸기"}</button></div></div>
    {demo && <aside className="demo-notice" aria-label="테스트 모드 안내"><strong>테스트 다이어리</strong><p className="demo-notice-detail">이 탭에 임시 저장됩니다. 새로고침 후에도 유지되며 다른 기기와 동기화되지 않습니다.</p></aside>}
    <div className="diary-page-navigation"><p className="diary-current-date">{label(firstDate.toString())}{dayCount === 2 && following ? ` — ${label(following)}` : ""}<span>{dayCount === 2 ? "이틀 보기" : "하루 보기"}</span></p>
      <div><DiaryDatePicker date={firstDate.toString()} today={session.serverDate} disabled={Boolean(gate) || signingOut} onSelect={selectDate} />
        <button type="button" aria-label="이전 날" disabled={Boolean(gate) || signingOut || firstDate.toString() === "0001-01-01"} onClick={() => selectDate(firstDate.subtract({ days: 1 }).toString())}>←</button>
        <button type="button" aria-label="다음 날" disabled={Boolean(gate) || signingOut || firstDate.toString() === "9999-12-31"} onClick={() => selectDate(firstDate.add({ days: 1 }).toString())}>→</button>
        {dayCount === 1 && following && <button type="button" className="diary-day-switch" disabled={Boolean(gate) || signingOut} onClick={() => setFocusedDate(singleDate === anchor ? following : anchor)}>다른 날짜 보기</button>}
      </div>
    </div>
    {error && <p role="alert" className="error-note">{error}</p>}
    <div className="diary-days" data-visible-days={dayCount} data-single-panel={singleDate === anchor ? "primary" : "secondary"}>
      {dates.map(day => <section key={day} className="planner-day" data-panel={day === anchor ? "primary" : day === following ? "secondary" : "cached"} data-date={day} aria-label={`${label(day)} 다이어리`} hidden={!shownDates.includes(day)} onFocusCapture={() => setFocusedDate(day)}>
        <PlannerDay initialSession={session} request={request} demo={demo} day={day} active={shownDates.includes(day)} primary={day === anchor} externalDisabled={signingOut || Boolean(gate && gate.day !== day)} onSession={onSession} onSessionFailure={onSessionFailure} authRecoveryRevision={authRecoveryRevision} taskRevision={taskRevision} onTasksChanged={onTasksChanged} {...binding(day)} />
      </section>)}
    </div>
  </main>;
}
