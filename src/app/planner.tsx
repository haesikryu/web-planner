"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { title as normalizeTitle } from "@/domain/rules";

export type PlannerSession = { userId: string; timezone: string; settingsVersion: number; serverDate: string; csrfToken: string };
type PlannerRequest = (path: string, init?: RequestInit) => Promise<Response>;
const serverRequest: PlannerRequest = (path, init) => fetch(path, init);
type Task = { id: string; title: string; status: "open" | "completed"; scheduledDate: string | null; isUnprocessed: boolean; version: number };
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
function listUrl(view: View, fresh: PlannerSession, cursor?: string) {
  const query = new URLSearchParams({ view });
  if (view !== "inbox") query.set("date", fresh.serverDate);
  if (cursor) query.set("cursor", cursor);
  return `/api/tasks?${query}`;
}
function describeChange(body: object): string {
  return ["title" in body ? `제목: ${String(body.title)}` : "", "scheduledDate" in body ? `실행일: ${body.scheduledDate ?? "없음"}` : "",
    "status" in body ? (body.status === "completed" ? "완료" : "완료 취소") : "",
    "isUnprocessed" in body ? (body.isUnprocessed ? "미정리로 표시" : "정리 완료") : ""].filter(Boolean).join(" · ");
}

export function Planner({ initialSession, request = serverRequest, demo = false }: { initialSession: PlannerSession; request?: PlannerRequest; demo?: boolean }) {
  const [session, setSession] = useState(initialSession), [pages, setPages] = useState(emptyPages);
  const [draft, setDraft] = useState(""), [message, setMessage] = useState("목록을 불러오는 중입니다.");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [locked, setLocked] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null), [conflict, setConflict] = useState<Task | null>(null);
  const [zone, setZone] = useState(initialSession.timezone);
  const [editing, setEditing] = useState<{ task: Task; title: string; date: string } | null>(null);
  const currentOwner = useRef(initialSession.userId), operation = useRef(false), loadSequence = useRef(0);
  const calendar = useRef(`${initialSession.timezone}|${initialSession.serverDate}`);
  const statusEpoch = useRef(0);

  const verifySession = useCallback(async (): Promise<PlannerSession> => {
    const response = await request("/api/session", { cache: "no-store" });
    if (!response.ok) { if (response.status === 401) { setLocked(true); setPages(emptyPages()); } throw new Error(demo ? "테스트 저장소를 확인할 수 없습니다. 입력을 보존했습니다. 브라우저 저장 설정을 확인하고 다시 시도해주세요." : "로그인 상태를 확인할 수 없습니다. 입력을 보존했습니다. 다시 시도해주세요."); }
    const fresh: PlannerSession = await response.json();
    if (fresh.userId !== currentOwner.current) {
      currentOwner.current = ""; setPages(emptyPages()); setDraft(""); setEditing(null); setPending(null); setConflict(null); setLocked(true);
      window.location.replace("/"); throw new Error("계정이 변경되어 이전 입력을 지웠습니다.");
    }
    const nextCalendar = `${fresh.timezone}|${fresh.serverDate}`;
    if (calendar.current !== nextCalendar) { calendar.current = nextCalendar; setPages(emptyPages()); }
    setLocked(false); setSession(fresh); return fresh;
  }, [request, demo]);
  const reload = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const fresh = await verifySession();
    const values = await Promise.all(views.map(async view => {
      const response = await request(listUrl(view.id, fresh), { cache: "no-store" });
      if (!response.ok) throw new Error("목록을 불러오지 못했습니다. 새로고침으로 다시 확인해주세요.");
      return [view.id, await response.json()] as const;
    }));
    const confirmed = await verifySession();
    if (confirmed.timezone !== fresh.timezone || confirmed.serverDate !== fresh.serverDate) throw new Error("날짜 기준이 변경되었습니다. 목록을 새로고침해주세요.");
    if (sequence === loadSequence.current && currentOwner.current) setPages(Object.fromEntries(values) as Record<View, Page>);
  }, [verifySession, request]);
  useEffect(() => {
    const epoch = statusEpoch.current;
    reload().then(() => { if (epoch === statusEpoch.current) setMessage(demo ? "이 탭에 저장된 테스트 목록입니다." : "서버에 저장된 목록입니다."); })
      .catch(cause => { if (epoch === statusEpoch.current) setError(cause.message); });
    const refresh = () => { if (!document.hidden && !operation.current) reload().catch(cause => setError(cause.message)); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 60000);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); window.clearInterval(timer); loadSequence.current++; };
  }, [reload, demo]);
  useEffect(() => {
    if (!draft && !pending && !editing && zone === session.timezone) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [draft, pending, editing, zone, session.timezone]);

  async function send(value: Pending) {
    if (operation.current || value.ownerId !== currentOwner.current) return;
    if (Date.now() - value.startedAt >= 86400000) { setError("24시간이 지난 요청은 자동 재전송하지 않습니다. 목록에서 저장 여부를 확인해주세요."); return; }
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
        if ([400, 404, 422, 428].includes(response.status)) { setPending(null); throw new Error("입력이나 항목을 확인해주세요. 저장하지 못했습니다."); }
        if (response.status === 412 && value.path === "/api/settings") { setPending(null); await verifySession(); throw new Error("설정이 다른 곳에서 변경되었습니다. 최신 설정을 확인한 후 다시 적용해주세요."); }
        throw new Error("저장 여부를 확인할 수 없습니다. 같은 요청으로 재시도하거나 목록을 확인해주세요.");
      }
      serverConfirmed = true;
      const confirmed = await verifySession();
      if (value.path === "/api/settings") setZone(confirmed.timezone);
      setPending(null); setConflict(null);
      if (value.method === "POST") setDraft("");
      setEditing(null); setMessage("저장 완료");
      await reload();
    } catch (cause) { setMessage(serverConfirmed ? "저장 완료 · 목록을 다시 확인해주세요." : "저장 확인 필요"); setError(cause instanceof Error && !(cause instanceof TypeError) ? cause.message : "저장 여부를 확인할 수 없습니다. 입력을 보존했습니다. 같은 요청으로 다시 시도해주세요."); }
    finally { operation.current = false; setBusy(false); }
  }
  function mutate(path: string, method: Pending["method"], body: object, version?: number) {
    if (pending || locked) return;
    void send({ path, method, body, version, key: crypto.randomUUID(), startedAt: Date.now(), ownerId: currentOwner.current });
  }
  function update(task: Task, body: object) { mutate(`/api/tasks/${task.id}`, "PATCH", body, task.version); }
  async function more(view: View) {
    try {
      const cursor = pages[view].nextCursor; if (!cursor) return;
      const fresh = await verifySession(), response = await request(listUrl(view, fresh, cursor), { cache: "no-store" });
      if (!response.ok) throw new Error("목록이 변경되었습니다. 새로고침해주세요.");
      const next: Page = await response.json(), confirmed = await verifySession();
      if (confirmed.timezone !== fresh.timezone || confirmed.serverDate !== fresh.serverDate) throw new Error("날짜 기준이 변경되었습니다. 목록을 새로고침해주세요.");
      setPages(old => ({ ...old, [view]: { items: [...new Map([...old[view].items, ...next.items].map(item => [item.id, item])).values()], nextCursor: next.nextCursor } }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "목록을 확인해주세요."); }
  }
  async function signOut() {
    if ((draft || pending || editing || zone !== session.timezone) && !window.confirm(demo ? "저장하지 않은 입력이 있습니다. 테스트를 나가면 입력을 지웁니다. 계속할까요?" : "저장하지 않은 입력이 있습니다. 로그아웃하면 입력을 지웁니다. 계속할까요?")) return;
    if (operation.current) return;
    operation.current = true; setBusy(true);
    try {
      const fresh = await verifySession();
      const result = await request("/api/logout", { method: "POST", headers: { "X-CSRF-Token": fresh.csrfToken } });
      if (!result.ok) throw new Error("로그아웃을 확인할 수 없습니다. 다시 시도해주세요.");
      currentOwner.current = ""; setPages(emptyPages()); setDraft(""); setPending(null); setEditing(null); setLocked(true); window.location.replace("/");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "연결을 확인해주세요."); }
    finally { operation.current = false; setBusy(false); }
  }
  const disabled = busy || Boolean(pending) || locked;
  let draftError = "";
  if (draft) { try { normalizeTitle(draft); } catch { draftError = "제목은 공백만 사용할 수 없으며 줄바꿈 없이 1~200자로 입력해주세요."; } }
  return <main id="main" className="planner">
    {demo && <aside className="demo-notice" aria-label="테스트 모드 안내"><strong>로그인 없는 테스트 모드</strong><p className="demo-notice-detail">입력한 내용은 이 브라우저 탭에만 저장됩니다. 새로고침 후에도 유지되지만 다른 기기와 동기화되지 않는 임시 데이터입니다.</p></aside>}
    <div className="planner-heading"><div><p className="eyebrow">ONE THING AT A TIME</p><h1>오늘을 가볍게.</h1><p className="date-line">{session.serverDate} · {session.timezone}</p></div>
      <button className="quiet-button" type="button" disabled={busy} onClick={() => void signOut()}>{demo ? "테스트 나가기" : "로그아웃 / 계정 바꾸기"}</button></div>
    <form className="capture" onSubmit={event => { event.preventDefault(); try { mutate("/api/tasks", "POST", { title: normalizeTitle(draft) }); } catch { setError("제목은 줄바꿈 없이 1~200자로 입력해주세요."); } }}>
      <label htmlFor="capture-title">지금 떠오른 일</label><div className="capture-row"><input id="capture-title" value={draft} disabled={disabled} aria-invalid={Boolean(draftError)} aria-describedby={draftError ? "capture-error" : "capture-help"} onChange={event => setDraft(event.target.value)} placeholder="제목 하나면 충분해요" autoComplete="off" />
        <button type="submit" disabled={disabled || !draft.trim() || Boolean(draftError)}>입력함에 저장</button></div><p id="capture-help" className="field-note">목표와 날짜는 나중에 정해도 괜찮아요.</p>{draftError && <p id="capture-error" role="alert" className="error-note">{draftError}</p>}</form>
    <div className="planner-notice"><p role="status" aria-live="polite">{message}</p><button type="button" className="quiet-button" disabled={busy} onClick={() => void reload().then(() => { setMessage("최신 목록을 확인했습니다."); setError(""); }).catch(cause => setError(cause.message))}>목록 새로고침</button></div>
    {error && <p role="alert" className="error-note">{error}</p>}
    {pending && !conflict && <div className="recovery"><p>입력과 저장 요청을 이 화면에 보관하고 있습니다.</p><button type="button" disabled={busy || locked} onClick={() => void send(pending)}>같은 요청 재시도</button><button type="button" disabled={busy} onClick={() => { if (window.confirm("목록에서 저장 여부를 확인했나요? 확인을 마치면 이전 요청을 닫습니다.")) { setPending(null); setMessage("이전 요청을 닫았습니다. 목록과 입력을 확인해주세요."); } }}>목록 확인 후 요청 닫기</button></div>}
    {conflict && pending && <section className="recovery" aria-label="수정 충돌 확인"><h2>최신 내용과 비교</h2><p>현재 저장된 제목: {conflict.title}</p><p>현재 상태: {conflict.status === "completed" ? "완료" : "미완료"} · 실행일: {conflict.scheduledDate ?? "없음"}</p>
      <p>내 변경: {describeChange(pending.body)}</p>
      <button type="button" onClick={() => { setPending(null); setConflict(null); setEditing(null); void reload().catch(cause => setError(cause.message)); }}>최신 내용 사용</button>
      <button type="button" onClick={() => { const retry = { ...pending, key: crypto.randomUUID(), version: conflict.version, startedAt: Date.now() }; setConflict(null); void send(retry); }}>내 변경 다시 적용</button></section>}
    {editing && <form className="edit-panel" onSubmit={event => { event.preventDefault(); try { update(editing.task, { title: normalizeTitle(editing.title), scheduledDate: editing.date || null }); } catch { setError("제목과 날짜를 확인해주세요."); } }}>
      <h2>할 일 수정</h2><label>제목<input value={editing.title} disabled={disabled} onChange={event => setEditing({ ...editing, title: event.target.value })} /></label>
      <label>실행 예정일<input type="date" value={editing.date} disabled={disabled} onChange={event => setEditing({ ...editing, date: event.target.value })} /></label>
      <button type="submit" disabled={disabled}>변경 저장</button><button type="button" disabled={busy} onClick={() => setEditing(null)}>수정 닫기</button></form>}
    <div className="planner-grid">{views.map(view => <section className="task-section" key={view.id} aria-label={view.label}>
      <div className="section-heading"><h2>{view.label}</h2><span>{pages[view.id].items.length}{pages[view.id].nextCursor ? "+" : ""}</span></div>
      {!pages[view.id].items.length && <p className="empty-state">{view.empty}</p>}
      <ul>{pages[view.id].items.map(task => <li key={task.id} className={task.status === "completed" ? "task-card completed" : "task-card"} data-task-id={task.id}>
        <p className="task-title">{task.title}</p><p className="task-meta">{task.scheduledDate ? `실행일 ${task.scheduledDate}` : "날짜 미정"}{task.isUnprocessed ? " · 미정리" : ""}</p>
        <div className="task-actions"><button type="button" disabled={disabled} onClick={() => update(task, { status: task.status === "completed" ? "open" : "completed" })}>{task.status === "completed" ? "완료 취소" : "완료"}</button>
          {task.status === "open" && (view.id !== "scheduled") && <button type="button" disabled={disabled} onClick={() => update(task, { scheduledDate: session.serverDate, isUnprocessed: false })}>오늘로</button>}
          {task.isUnprocessed && <button type="button" disabled={disabled} onClick={() => update(task, { isUnprocessed: false })}>정리 완료</button>}
          <button type="button" disabled={disabled} onClick={() => setEditing({ task, title: task.title, date: task.scheduledDate ?? "" })}>수정</button></div>
      </li>)}</ul>{pages[view.id].nextCursor && <button type="button" className="quiet-button" disabled={disabled} onClick={() => void more(view.id)}>더 보기</button>}
    </section>)}</div>
    <details className="timezone-panel"><summary>기준 시간대 설정 · {session.timezone}</summary><form onSubmit={event => { event.preventDefault(); mutate("/api/settings", "PATCH", { timezone: zone }, session.settingsVersion); }}>
      <label htmlFor="timezone">IANA 시간대</label><input id="timezone" value={zone} disabled={disabled} onChange={event => setZone(event.target.value)} placeholder="Asia/Seoul" /><button disabled={disabled} type="submit">시간대 적용</button><p>기존 실행일은 유지하고, 오늘의 기준과 완료 기록 표시를 바꿉니다.</p></form></details>
  </main>;
}
