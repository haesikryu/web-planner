"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { title as normalizeTitle } from "@/domain/rules";
import { Temporal } from "@js-temporal/polyfill";
import { DailyTasks, type InlineTaskEdit } from "./daily-tasks";
import { JournalEditor, type JournalState } from "./journal-editor";
import { ScheduleEditor, type ScheduleState } from "./schedule-editor";
import { type TaskStatus, taskStatus } from "@/domain/task-options";

import type { PlannerSession, PlannerTask } from "./planner";
type PlannerRequest = (path: string, init?: RequestInit) => Promise<Response>;
export type DayState = { date: string; ownerId: string; dirty: boolean; blocked: boolean; working: boolean; generation: number };
type Task = PlannerTask;
const statusLabels: Record<TaskStatus, string> = { open: "진행 전", completed: "완료", deferred: "미룸", canceled: "취소" };
const statusSymbols: Record<TaskStatus, string> = { open: "□", completed: "✓", deferred: "→", canceled: "×" };
type View = "inbox" | "scheduled" | "overdue" | "completed";
type Page = { items: Task[]; nextCursor: string | null };
type Pending = { path: string; method: "POST" | "PATCH"; body: object; key: string; version?: number; startedAt: number; ownerId: string };
const views: { id: View; label: string; empty: string }[] = [
  { id: "scheduled", label: "오늘의 할 일", empty: "오늘에 놓을 일을 입력함에서 골라보세요." },
  { id: "inbox", label: "입력함", empty: "떠오른 일을 가볍게 남겨보세요." },
  { id: "overdue", label: "이전 날짜의 미완료", empty: "이전 날짜에 남은 일이 없습니다." },
  { id: "completed", label: "오늘 완료", empty: "완료한 일은 이곳에 모입니다." }
];
const emptyPages = (): Record<View, Page> => ({ inbox: { items: [], nextCursor: null }, scheduled: { items: [], nextCursor: null }, overdue: { items: [], nextCursor: null }, completed: { items: [], nextCursor: null } });
function listUrl(view: View, date: string, cursor?: string) {
  const query = new URLSearchParams({ view: view === "scheduled" ? "day" : view });
  if (view !== "inbox") query.set("date", date);
  if (cursor) query.set("cursor", cursor);
  return `/api/tasks?${query}`;
}
function describeChange(body: object): string {
  return ["title" in body ? `제목: ${String(body.title)}` : "", "scheduledDate" in body ? `실행일: ${body.scheduledDate ?? "없음"}` : "",
    "status" in body ? `상태: ${statusLabels[body.status as TaskStatus]}` : "",
    "move" in body ? `순서: ${body.move === "up" ? "한 줄 위로" : "한 줄 아래로"}` : "",
    "moveTo" in body ? "순서: 선택한 줄의 위치로 이동" : "",
    "isUnprocessed" in body ? (body.isUnprocessed ? "미정리로 표시" : "정리 완료") : ""].filter(Boolean).join(" · ");
}

export function PlannerDay({ initialSession: session, request, demo, day, active, primary, externalDisabled, onSession, onSessionFailure, authRecoveryRevision, onStateChange, onClaim, taskRevision, onTasksChanged }: {
  initialSession: PlannerSession; request: PlannerRequest; demo: boolean; day: string; active: boolean; primary: boolean;
  externalDisabled: boolean; onSession: (value: PlannerSession) => PlannerSession; onStateChange: (value: DayState) => void; onClaim: (generation: number) => boolean;
  onSessionFailure: (ownerId: string) => void; authRecoveryRevision: number;
  taskRevision: number; onTasksChanged: () => void;
}) {
  const [pages, setPages] = useState(emptyPages);
  const [draft, setDraft] = useState(""), [message, setMessage] = useState("목록을 불러오는 중입니다.");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [locked, setLocked] = useState(false);
  const sessionFailureMessage = demo ? "테스트 저장소를 확인할 수 없습니다. 입력을 보존했습니다. 브라우저 저장 설정을 확인하고 다시 시도해주세요." : "로그인 상태를 확인할 수 없습니다. 입력을 보존했습니다. 다시 시도해주세요.";
  const clearSessionError = useCallback(() => setError(old => old === sessionFailureMessage ? "" : old), [sessionFailureMessage]);
  const recoveryRevision = useRef(authRecoveryRevision), authFailureRevision = useRef<number | null>(null);
  recoveryRevision.current = authRecoveryRevision;
  const [pending, setPending] = useState<Pending | null>(null), [conflict, setConflict] = useState<Task | null>(null);
  const [asyncClaim, setAsyncClaim] = useState(false);
  const asyncClaimRef = useRef(false);
  const operationGeneration = useRef(0);
  const claimOperation = useCallback(() => {
    const generation = operationGeneration.current + 1;
    if (!onClaim(generation)) return false;
    operationGeneration.current = generation; return true;
  }, [onClaim]);
  const claimAsyncOperation = useCallback(() => {
    if (asyncClaimRef.current || !claimOperation()) return false;
    asyncClaimRef.current = true; setAsyncClaim(true); return true;
  }, [claimOperation]);
  const finishAsyncOperation = useCallback(() => { asyncClaimRef.current = false; setAsyncClaim(false); }, []);
  const [inlineEditing, setInlineEditingState] = useState<InlineTaskEdit | null>(null);
  const inlineEditRef = useRef<InlineTaskEdit | null>(null);
  const setInlineEditing = useCallback((value: InlineTaskEdit | null) => { if (value && !inlineEditRef.current && !claimOperation()) return; inlineEditRef.current = value; setInlineEditingState(value); }, [claimOperation]);
  const focusNextInput = useRef(false);
  const [zone, setZone] = useState(session.timezone);
  const [zoneDirty, setZoneDirty] = useState(false);
  const zoneValue = zoneDirty ? zone : session.timezone;
  const idPrefix = primary ? "" : `day-${day}-`;
  const selectedDate = day;
  const [mobilePage, setMobilePage] = useState<"plan" | "journal">("plan");
  const [dragging, setDragging] = useState(false);
  const dragActive = useRef(false);
  const setDragActive = useCallback((active: boolean) => { if (active && !dragActive.current && !claimOperation()) return false; dragActive.current = active; setDragging(active); return true; }, [claimOperation]);
  const [listsReady, setListsReady] = useState(false);
  const [scheduleState, setScheduleState] = useState<ScheduleState>({ dirty: false, busy: false, pending: false, pendingDate: null });
  const [journalState, setJournalState] = useState<JournalState>({ dirty: false, busy: false, pending: false, pendingDate: null });
  const [editing, setEditing] = useState<{ task: Task; title: string; date: string; status: TaskStatus } | null>(null);
  const currentOwner = useRef(session.userId), operation = useRef(false), loadSequence = useRef(0);
  const calendar = useRef(`${session.timezone}|${session.serverDate}`);
  const loadedCalendar = useRef<{ date: string; timezone: string } | null>(null);
  const statusEpoch = useRef(0);
  const selectedDateRef = useRef<string | null>(day);
  const captureInput = useRef<HTMLInputElement>(null), editInput = useRef<HTMLInputElement>(null);
  const editingId = editing?.task.id;
  useEffect(() => { if (editingId) editInput.current?.focus(); }, [editingId]);

  const verifySession = useCallback(async (): Promise<PlannerSession> => {
    const response = await request("/api/session", { cache: "no-store" });
    if (!response.ok) { if (response.status === 401) { authFailureRevision.current = recoveryRevision.current; onSessionFailure(currentOwner.current); setLocked(true); if (!inlineEditRef.current) { setPages(emptyPages()); setListsReady(false); } } throw new Error(sessionFailureMessage); }
    const fresh = onSession(await response.json());
    if (fresh.userId !== currentOwner.current) {
      currentOwner.current = ""; setPages(emptyPages()); setDraft(""); setInlineEditing(null); setEditing(null); setPending(null); setConflict(null); setLocked(true);
      window.location.replace("/"); throw new Error("계정이 변경되어 이전 입력을 지웠습니다.");
    }
    const nextCalendar = `${fresh.timezone}|${fresh.serverDate}`;
    if (calendar.current !== nextCalendar) { calendar.current = nextCalendar; if (!inlineEditRef.current && !dragActive.current) { loadedCalendar.current = null; setPages(emptyPages()); setListsReady(false); } }
    authFailureRevision.current = null; setLocked(false); clearSessionError(); return fresh;
  }, [request, sessionFailureMessage, clearSessionError, setInlineEditing, onSession, onSessionFailure]);
  const reload = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const fresh = await verifySession();
    if (inlineEditRef.current || dragActive.current) return;
    const date = scheduleState.pendingDate ?? journalState.pendingDate ?? selectedDate ?? fresh.serverDate;
    const values = await Promise.all(views.map(async view => {
      const response = await request(listUrl(view.id, date), { cache: "no-store" });
      if (!response.ok) throw new Error("목록을 불러오지 못했습니다. 새로고침으로 다시 확인해주세요.");
      return [view.id, await response.json()] as const;
    }));
    const confirmed = await verifySession();
    if (confirmed.timezone !== fresh.timezone || confirmed.serverDate !== fresh.serverDate) throw new Error("날짜 기준이 변경되었습니다. 목록을 새로고침해주세요.");
    if (sequence === loadSequence.current && currentOwner.current && !inlineEditRef.current && !dragActive.current) { loadedCalendar.current = { date, timezone: fresh.timezone }; setPages(Object.fromEntries(values) as Record<View, Page>); setListsReady(true); }
  }, [verifySession, request, selectedDate, journalState.pendingDate, scheduleState.pendingDate]);
  useEffect(() => {
    if (!active) return;
    const epoch = statusEpoch.current;
    reload().then(() => { if (epoch === statusEpoch.current) setMessage(demo ? "이 탭에 저장된 테스트 목록입니다." : "서버에 저장된 목록입니다."); })
      .catch(cause => { if (epoch === statusEpoch.current) setError(cause.message); });
    const refresh = () => { if (!document.hidden && !operation.current) { const epoch = statusEpoch.current; reload().catch(cause => { if (epoch === statusEpoch.current) setError(cause.message); }); } };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 60000);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); window.clearInterval(timer); loadSequence.current++; };
  }, [reload, demo, active]);
  useEffect(() => {
    if (taskRevision && active && !operation.current) void reload().catch(cause => setError(cause.message));
  }, [taskRevision, active, reload]);
  useEffect(() => {
    // A verified session in either day releases only older authentication locks.
    // Keep pending requests and drafts; unaffected panels do not start a refresh loop.
    if (authFailureRevision.current === null || authFailureRevision.current >= authRecoveryRevision) return;
    authFailureRevision.current = null; setLocked(false); clearSessionError();
    if (active && !asyncClaimRef.current) void reload().catch(cause => setError(cause.message));
  }, [authRecoveryRevision, active, reload, clearSessionError]);

  async function send(value: Pending) {
    if (operation.current || value.ownerId !== currentOwner.current) return;
    if (Date.now() - value.startedAt >= 86400000) { setError("24시간이 지난 요청은 자동 재전송하지 않습니다. 목록에서 저장 여부를 확인해주세요."); return; }
    if (!claimAsyncOperation()) return;
    operation.current = true; statusEpoch.current++; setBusy(true); setError(""); setMessage("저장 중입니다."); setPending(value);
    let serverConfirmed = false;
    try {
      const fresh = await verifySession();
      const response = await request(value.path, { method: value.method, headers: { "Content-Type": "application/json", "X-CSRF-Token": fresh.csrfToken,
        "Idempotency-Key": value.key, ...(value.version ? { "If-Match": `"v${value.version}"` } : {}) }, body: JSON.stringify(value.body) });
      if (response.status === 412 && value.path.startsWith("/api/tasks/")) {
        const latest = await request(value.path, { cache: "no-store" });
        await verifySession();
        if (latest.ok) { setConflict(await latest.json()); setMessage("수정 충돌 확인 필요"); setError("다른 곳에서 변경한 내용이 있습니다. 최신 내용과 내 변경을 확인해주세요."); return; }
      }
      if (!response.ok) {
        if ([400, 404, 422, 428].includes(response.status)) {
          setPending(null);
          const failure = await response.json().catch(() => null);
          if (failure?.code === "DAILY_TASK_LIMIT") { await reload(); throw new Error("이 날짜의 할 일은 최대 5개입니다. 기존 할 일의 날짜를 옮긴 뒤 추가해주세요."); }
          throw new Error("입력이나 항목을 확인해주세요. 저장하지 못했습니다.");
        }
        if (response.status === 412 && value.path === "/api/settings") { setPending(null); await verifySession(); throw new Error("설정이 다른 곳에서 변경되었습니다. 최신 설정을 확인한 후 다시 적용해주세요."); }
        throw new Error("저장 여부를 확인할 수 없습니다. 같은 요청으로 재시도하거나 목록을 확인해주세요.");
      }
      serverConfirmed = true;
      const confirmed = await verifySession();
      if (value.path.startsWith("/api/tasks")) onTasksChanged();
      if (value.path === "/api/settings") { setZone(confirmed.timezone); setZoneDirty(false); }
      setPending(null); setConflict(null);
      if (value.method === "POST") setDraft("");
      setEditing(null); setInlineEditing(null); setMessage("status" in value.body && value.body.status === "completed" && selectedDate && selectedDate !== confirmed.serverDate ? `완료했습니다. ${confirmed.serverDate}의 완료 기록에서 확인하세요.` : "저장 완료");
      await reload();
    } catch (cause) { setMessage(serverConfirmed ? "저장 완료 · 목록을 다시 확인해주세요." : "저장 확인 필요"); setError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : "저장 여부를 확인할 수 없습니다. 입력을 보존했습니다. 같은 요청으로 다시 시도해주세요."); }
    finally { operation.current = false; setBusy(false); finishAsyncOperation(); }
  }
  function mutate(path: string, method: Pending["method"], body: object, version?: number, fromEditor = false) {
    if (pending || locked || dragActive.current || journalState.busy || journalState.pending || scheduleState.busy || scheduleState.pending || ((editing || inlineEditing) && !fromEditor)) return;
    void send({ path, method, body, version, key: crypto.randomUUID(), startedAt: Date.now(), ownerId: currentOwner.current });
  }
  function update(task: Task, body: object, fromEditor = false) { mutate(`/api/tasks/${task.id}`, "PATCH", body, task.version, fromEditor); }
  async function more(view: View) {
    const epoch = statusEpoch.current, sequence = loadSequence.current, selection = selectedDateRef.current;
    try {
      const cursor = pages[view].nextCursor; if (!cursor) return;
      const fresh = await verifySession(), response = await request(listUrl(view, selection ?? fresh.serverDate, cursor), { cache: "no-store" });
      if (!response.ok) throw new Error("목록이 변경되었습니다. 새로고침해주세요.");
      const next: Page = await response.json(), confirmed = await verifySession();
      if (confirmed.timezone !== fresh.timezone || confirmed.serverDate !== fresh.serverDate) throw new Error("날짜 기준이 변경되었습니다. 목록을 새로고침해주세요.");
      if (sequence !== loadSequence.current || selection !== selectedDateRef.current) return;
      setPages(old => ({ ...old, [view]: { items: [...new Map([...old[view].items, ...next.items].map(item => [item.id, item])).values()], nextCursor: next.nextCursor } }));
    } catch (cause) { if (epoch === statusEpoch.current && sequence === loadSequence.current && selection === selectedDateRef.current) setError(cause instanceof Error ? cause.message : "목록을 확인해주세요."); }
  }
  async function refreshPage() {
    const epoch = ++statusEpoch.current;
    try { await reload(); if (epoch === statusEpoch.current) { setMessage("최신 목록을 확인했습니다."); setError(""); } }
    catch (cause) { if (epoch === statusEpoch.current) setError(cause instanceof Error ? cause.message : "목록을 확인해주세요."); }
  }
  const disabled = externalDisabled || busy || Boolean(pending) || locked || journalState.busy || journalState.pending || scheduleState.busy || scheduleState.pending;
  const date = Temporal.PlainDate.from(inlineEditing?.task.scheduledDate ?? (dragging ? pages.scheduled.items[0]?.scheduledDate : null) ?? scheduleState.pendingDate ?? journalState.pendingDate ?? selectedDate ?? session.serverDate);
  const isToday = date.toString() === session.serverDate;
  const navigationDisabled = disabled || dragging || Boolean(editing) || Boolean(inlineEditing);
  const visibleDate = date.toString();
  const ownBlocked = asyncClaim || busy || Boolean(pending) || locked || dragging || Boolean(editing) || Boolean(inlineEditing) || journalState.busy || journalState.pending || scheduleState.busy || scheduleState.pending;
  const dirty = Boolean(draft || pending || editing || inlineEditing) || journalState.dirty || journalState.pending || scheduleState.dirty || scheduleState.pending || (zoneDirty && zone !== session.timezone);
  const working = asyncClaim || busy || journalState.busy || scheduleState.busy;
  const pendingPage = journalState.pending ? "journal" : scheduleState.pending ? "plan" : null;
  const displayedPage = pendingPage ?? mobilePage;
  const reportedGeneration = operationGeneration.current;
  useEffect(() => {
    onStateChange({ date: visibleDate, ownerId: session.userId, dirty, blocked: ownBlocked, working, generation: reportedGeneration });
  }, [onStateChange, visibleDate, session.userId, dirty, ownBlocked, working, reportedGeneration]);
  useEffect(() => {
    // A canceled edit/drag must release the old day snapshot after a clock/zone change.
    if (!active || dragging || inlineEditing || !loadedCalendar.current || (loadedCalendar.current.date === visibleDate && loadedCalendar.current.timezone === session.timezone)) return;
    loadedCalendar.current = null; setPages(emptyPages()); setListsReady(false);
    void reload().catch(cause => setError(cause.message));
  }, [dragging, inlineEditing, visibleDate, session.timezone, reload, active]);
  useEffect(() => {
    if (!busy && !pending && listsReady && focusNextInput.current && !draft) { focusNextInput.current = false; captureInput.current?.focus(); }
  }, [busy, pending, listsReady, draft]);
  function viewLabel(view: View) {
    if (view === "scheduled" && !isToday) return "이날의 할 일";
    if (view === "completed" && !isToday) return "이날 완료";
    return views.find(item => item.id === view)?.label ?? "";
  }
  let draftError = "";
  if (draft) { try { normalizeTitle(draft); } catch { draftError = "제목은 공백만 사용할 수 없으며 줄바꿈 없이 1~200자로 입력해주세요."; } }
  function createDailyTask(focusNext: boolean) {
    if (operation.current || navigationDisabled || !listsReady || pages.scheduled.items.length >= 5 || pages.scheduled.nextCursor) return;
    try {
      const title = normalizeTitle(draft); focusNextInput.current = focusNext;
      mutate("/api/tasks", "POST", { title, scheduledDate: date.toString(), isUnprocessed: false });
    } catch { setError("제목은 줄바꿈 없이 1~200자로 입력해주세요."); }
  }
  function renameDailyTask(task: Task, value: string) {
    if (disabled || editing) return;
    try { update(task, { title: normalizeTitle(value) }, true); }
    catch { setError("제목은 줄바꿈 없이 1~200자로 입력해주세요."); }
  }
  function beginEdit(task: Task) {
    if (navigationDisabled || !claimOperation()) return;
    setEditing({ task, title: task.title, date: task.scheduledDate ?? "", status: task.status });
  }
  function taskSection(view: typeof views[number]) { return <section className="task-section" key={view.id} id={`${idPrefix}diary-${view.id}`} aria-label={viewLabel(view.id)}>
      <div className="section-heading"><h2>{viewLabel(view.id)}</h2><span className="task-count">{pages[view.id].items.length}{pages[view.id].nextCursor ? "+" : ""}</span></div>
      {!pages[view.id].items.length && <p className="empty-state">{view.id === "scheduled" ? "작은 일부터 하나씩 채워보세요." : view.empty}</p>}
      <ul>{pages[view.id].items.map(task => <li key={task.id} className={`task-card ${task.status}`} data-task-id={task.id}>
        <div className="task-title-row"><p className="task-title"><span className="bullet-symbol" role="img" aria-label={statusLabels[task.status]}>{statusSymbols[task.status]}</span><span>{task.title}</span></p></div>
        <p className="task-meta">{task.scheduledDate ? `실행일 ${task.scheduledDate}` : "날짜 미정"}{task.isUnprocessed ? " · 미정리" : ""}</p>
        <div className="task-controls"><label>상태<select aria-label={`${task.title} 상태`} value={task.status} disabled={navigationDisabled} onChange={event => update(task, { status: taskStatus(event.target.value) })}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{statusSymbols[value as TaskStatus]} {label}</option>)}</select></label></div>
        {task.status === "deferred" && <p className="task-state-note">→ 미룸 · 실행일은 수정에서 변경할 수 있습니다.</p>}
        <div className="task-actions"><button type="button" disabled={navigationDisabled} onClick={() => update(task, { status: task.status === "completed" ? "open" : task.status === "canceled" ? "open" : "completed" })}>{task.status === "completed" ? "완료 취소" : task.status === "canceled" ? "취소 되돌리기" : "완료"}</button>
          {(task.status === "open" || task.status === "deferred") && (view.id !== "scheduled") && <button type="button" disabled={navigationDisabled} onClick={() => update(task, { scheduledDate: date.toString(), isUnprocessed: false })}>{isToday ? "오늘로" : "이날로"}</button>}
          {task.isUnprocessed && (task.scheduledDate !== null || task.status === "completed") && <button type="button" disabled={navigationDisabled} onClick={() => update(task, { isUnprocessed: false })}>정리 완료</button>}
          <button type="button" disabled={navigationDisabled} onClick={() => beginEdit(task)}>수정</button></div>
      </li>)}</ul>{pages[view.id].nextCursor && <button type="button" className="quiet-button" disabled={navigationDisabled} onClick={() => void more(view.id)}>더 보기</button>}
    </section>; }
  return <div className="diary-content">
    <div className="planner-notice"><p className="save-status" role="status" aria-live="polite">{message}</p><button type="button" className="quiet-button" disabled={busy || dragging || Boolean(inlineEditing)} onClick={() => void refreshPage()}>목록 새로고침</button></div>
    <div className="planner-feedback">
    {error && <p role="alert" className="error-note">{error}</p>}
    {pending && !conflict && <div className="recovery"><p>입력과 저장 요청을 이 화면에 보관하고 있습니다.</p><button type="button" disabled={busy || locked} onClick={() => void send(pending)}>같은 요청 재시도</button><button type="button" disabled={busy} onClick={() => { if (window.confirm("목록에서 저장 여부를 확인했나요? 확인을 마치면 이전 요청을 닫습니다.")) { setPending(null); setMessage("이전 요청을 닫았습니다. 목록과 입력을 확인해주세요."); } }}>목록 확인 후 요청 닫기</button></div>}
    {conflict && pending && <section className="recovery" aria-label="수정 충돌 확인"><h2>최신 내용과 비교</h2><p>현재 저장된 제목: {conflict.title}</p><p>현재 상태: {statusLabels[conflict.status]} · 실행일: {conflict.scheduledDate ?? "없음"}</p>
      <p>내 변경: {describeChange(pending.body)}</p>
      <button type="button" onClick={() => { setPending(null); setConflict(null); setEditing(null); setInlineEditing(null); void reload().catch(cause => setError(cause.message)); }}>최신 내용 사용</button>
      <button type="button" onClick={() => { const retry = { ...pending, key: crypto.randomUUID(), version: conflict.version, startedAt: Date.now() }; setConflict(null); void send(retry); }}>내 변경 다시 적용</button></section>}
    {editing && <form className="edit-panel" onSubmit={event => { event.preventDefault(); try { update(editing.task, { title: normalizeTitle(editing.title), scheduledDate: editing.date || null, status: editing.status }, true); } catch { setError("제목과 날짜를 확인해주세요."); } }}>
      <h2>할 일 수정</h2><label>제목<input ref={editInput} value={editing.title} disabled={disabled} onChange={event => setEditing({ ...editing, title: event.target.value })} /></label>
      <label>실행 예정일<input type="date" value={editing.date} disabled={disabled} onChange={event => setEditing({ ...editing, date: event.target.value })} /></label>
      <div className="entry-options"><label>진행 상태<select aria-label="진행 상태" value={editing.status} disabled={disabled} onChange={event => setEditing({ ...editing, status: taskStatus(event.target.value) })}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{statusSymbols[value as TaskStatus]} {label}</option>)}</select></label></div>
      <p className="field-note">미룸은 상태 표시입니다. 날짜를 옮기려면 실행 예정일도 변경해주세요.</p>
      <button type="submit" disabled={disabled}>변경 저장</button><button type="button" disabled={busy} onClick={() => setEditing(null)}>수정 닫기</button></form>}
    </div>
    <div className="diary-mobile-tabs" role="tablist" aria-label="다이어리 페이지">
      <button type="button" id={`${idPrefix}plan-tab`} data-page="plan" role="tab" aria-selected={displayedPage === "plan"} aria-controls={`${idPrefix}plan-page`} disabled={dragging || pendingPage === "journal"} onClick={() => setMobilePage("plan")}>할 일·일정</button>
      <button type="button" id={`${idPrefix}journal-tab`} role="tab" aria-selected={displayedPage === "journal"} aria-controls={`${idPrefix}journal-page`} disabled={dragging || pendingPage === "plan"} onClick={() => setMobilePage("journal")}>자유 기록</button>
    </div>
    <div className="diary-book" data-mobile-page={displayedPage}>
      <div className="diary-page diary-page-left" id={`${idPrefix}plan-page`}>
        <header className="diary-day-heading"><span className="diary-day-number">{String(date.day).padStart(2, "0")}</span><div><p className="diary-weekday">{["월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"][date.dayOfWeek - 1]} · {date.month}월</p><h1>{isToday ? "오늘을 가볍게." : "하루를 차분하게."}</h1><p className="date-line">{date.toString()} · {session.timezone}</p></div></header>
        <p className="page-intention">모든 일을 끝내기보다, 중요한 일에 한 걸음.</p>
        <details className="task-symbol-guide"><summary>기호 안내</summary><div className="symbol-legend"><span>□ 진행 전</span><span>✓ 완료</span><span>→ 미룸</span><span>× 취소</span></div></details>


        <DailyTasks idPrefix={idPrefix} tasks={pages.scheduled.items} label={viewLabel("scheduled")} ready={listsReady} disabled={disabled || Boolean(editing)} hasMore={Boolean(pages.scheduled.nextCursor)}
          draft={draft} onDraft={setDraft} draftError={draftError} inline={inlineEditing} onInline={setInlineEditing} inputRef={captureInput}
          onCreate={createDailyTask} onRename={renameDailyTask} onStatus={(task, status) => update(task, { status })} onMove={(task, moveTo) => update(task, { moveTo })} onDragActive={setDragActive}
          onEdit={beginEdit} onMore={() => void more("scheduled")} />
        <ScheduleEditor active={active} idPrefix={idPrefix} canStartOperation={claimAsyncOperation} onOperationEnd={finishAsyncOperation} date={date.toString()} ownerId={currentOwner.current} disabled={externalDisabled || busy || dragging || Boolean(pending) || locked || Boolean(editing) || Boolean(inlineEditing) || journalState.busy || journalState.pending} demo={demo} request={request} verifySession={verifySession} onStateChange={setScheduleState} />
        <details className="archive-tasks" id={`${idPrefix}diary-archive`}><summary>이전 기록과 입력함</summary>
        {taskSection(views[1])}
        {taskSection(views[3])}
        <p className="completion-note">완료한 일은 실제로 마친 날짜의 기록에 모입니다.</p>
        {taskSection(views[2])}
        </details>
        <footer className="diary-page-footer"><span>DAILY PLAN</span><span className="page-number">{String(date.day * 2 - 1).padStart(2, "0")}</span></footer>
      </div>
      <div className="diary-page diary-page-right" id={`${idPrefix}journal-page`}>
        <JournalEditor active={active} idPrefix={idPrefix} canStartOperation={claimAsyncOperation} onOperationEnd={finishAsyncOperation} date={date.toString()} ownerId={currentOwner.current} disabled={externalDisabled || busy || dragging || Boolean(pending) || locked || Boolean(editing) || Boolean(inlineEditing) || scheduleState.busy || scheduleState.pending} demo={demo} request={request} verifySession={verifySession} onStateChange={setJournalState} />
        <footer className="diary-page-footer"><span>DAILY NOTES</span><span className="page-number">{String(date.day * 2).padStart(2, "0")}</span></footer>
      </div>
    </div>
    {primary && <details className="timezone-panel"><summary>기준 시간대 설정 · {session.timezone}</summary><form onSubmit={event => { event.preventDefault(); mutate("/api/settings", "PATCH", { timezone: zoneValue }, session.settingsVersion); }}>
      <label htmlFor={`${idPrefix}timezone`}>IANA 시간대</label><input id={`${idPrefix}timezone`} value={zoneValue} disabled={navigationDisabled} onChange={event => { setZone(event.target.value); setZoneDirty(true); }} placeholder="Asia/Seoul" /><button disabled={navigationDisabled} type="submit">시간대 적용</button><p className="timezone-help">기존 실행일은 유지하고, 오늘의 기준과 완료 기록 표시를 바꿉니다.</p></form></details>}
  </div>;
}
