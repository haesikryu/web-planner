"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { JOURNAL_MAX_LENGTH, journalContent, type JournalEntry } from "@/domain/journal";
import type { PlannerSession } from "./planner";

type Draft = { entry: JournalEntry; content: string; loaded: boolean; loading: boolean; error: string; message: string };
type Pending = { owner: string; date: string; content: string; version: number; key: string; startedAt: number };
export type JournalState = { dirty: boolean; busy: boolean; pending: boolean; pendingDate: string | null };
type Props = {
  idPrefix?: string; active?: boolean; canStartOperation?: () => boolean; onOperationEnd?: () => void;
  date: string; ownerId: string; disabled: boolean; demo: boolean;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  verifySession: () => Promise<PlannerSession>;
  onStateChange: (state: JournalState) => void;
};
const blank = (date: string): Draft => ({ entry: { date, content: "", version: 0, updatedAt: null }, content: "", loaded: false, loading: false, error: "", message: "글을 불러오는 중입니다." });

export function JournalEditor({ date, ownerId, disabled, demo, request, verifySession, onStateChange, idPrefix = "", active = true, canStartOperation, onOperationEnd }: Props) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false), [pending, setPending] = useState<Pending | null>(null);
  const [conflict, setConflict] = useState<JournalEntry | null>(null);
  const draftsRef = useRef(drafts), ownerRef = useRef(ownerId), sequences = useRef<Record<string, number>>({});
  const cacheOwner = useRef(ownerId), operation = useRef(false);
  draftsRef.current = drafts; ownerRef.current = ownerId;
  const page = ownerId && cacheOwner.current === ownerId ? drafts[date] ?? blank(date) : blank(date);
  const dirty = page.loaded && page.content !== page.entry.content;
  const update = useCallback((day: string, change: Partial<Draft>) => {
    setDrafts(old => ({ ...old, [day]: { ...(old[day] ?? blank(day)), ...change } }));
  }, []);
  const read = useCallback(async (day: string, owner: string): Promise<JournalEntry> => {
    const before = await verifySession();
    if (before.userId !== owner || ownerRef.current !== owner) throw new Error("계정이 변경되었습니다.");
    const response = await request(`/api/journal/${day}`, { cache: "no-store" });
    const after = await verifySession();
    if (after.userId !== owner || ownerRef.current !== owner) throw new Error("계정이 변경되었습니다.");
    if (!response.ok) throw new Error("글을 불러오지 못했습니다. 다시 시도해주세요.");
    return response.json();
  }, [request, verifySession]);
  const load = useCallback(async (day: string, owner: string) => {
    const sequence = (sequences.current[day] ?? 0) + 1;
    sequences.current[day] = sequence;
    update(day, { loading: true, error: "", message: "글을 불러오는 중입니다." });
    try {
      const entry = await read(day, owner);
      if (ownerRef.current !== owner || sequences.current[day] !== sequence) return;
      update(day, { entry, content: entry.content, loaded: true, loading: false, message: entry.version ? "저장된 글입니다." : "오늘의 생각을 자유롭게 남겨보세요." });
    } catch (cause) {
      if (ownerRef.current === owner && sequences.current[day] === sequence) update(day, { loading: false, error: cause instanceof Error ? cause.message : "글을 불러오지 못했습니다.", message: "글 불러오기 확인 필요" });
    }
  }, [read, update]);
  useEffect(() => {
    if (cacheOwner.current === ownerId) return;
    cacheOwner.current = ownerId; draftsRef.current = {}; operation.current = false;
    setDrafts({}); setPending(null); setConflict(null); setBusy(false);
  }, [ownerId]);
  useEffect(() => {
    if (!active || !ownerId) return;
    const cached = draftsRef.current[date];
    if (cached?.loaded && cached.content !== cached.entry.content) return;
    void load(date, ownerId);
  }, [date, ownerId, load, active]);
  useEffect(() => {
    onStateChange({ dirty: Boolean(ownerId) && Object.values(drafts).some(value => value.loaded && value.content !== value.entry.content), busy, pending: Boolean(pending), pendingDate: pending?.date ?? null });
  }, [drafts, busy, pending, ownerId, onStateChange]);

  async function send(value: Pending) {
    if (operation.current || busy || disabled || ownerRef.current !== value.owner) return;
    if (Date.now() - value.startedAt >= 86400000) { update(value.date, { error: "24시간이 지난 요청입니다. 저장 여부를 확인한 뒤 다시 저장해주세요." }); return; }
    if (canStartOperation && !canStartOperation()) return;
    operation.current = true; setBusy(true); setPending(value); setConflict(null);
    update(value.date, { error: "", message: "글을 저장하는 중입니다." });
    try {
      const session = await verifySession();
      if (session.userId !== value.owner || ownerRef.current !== value.owner) return;
      const response = await request(`/api/journal/${value.date}`, { method: "PUT", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken,
        "Idempotency-Key": value.key, "If-Match": `"v${value.version}"` }, body: JSON.stringify({ content: value.content }) });
      if (response.status === 412) {
        const latest = await read(value.date, value.owner);
        if (ownerRef.current !== value.owner) return;
        setConflict(latest); update(value.date, { error: "다른 곳에서 글이 변경되었습니다. 저장된 글과 내 글을 비교해주세요.", message: "글 충돌 확인 필요" }); return;
      }
      if (!response.ok) {
        if ([400, 422, 428].includes(response.status)) setPending(null);
        throw new Error("글의 저장을 확인할 수 없습니다. 입력을 보존했습니다.");
      }
      const latest = await read(value.date, value.owner);
      if (ownerRef.current !== value.owner) return;
      if (latest.content !== value.content) {
        setConflict(latest); update(value.date, { error: "저장 후 다른 곳에서 글이 변경되었습니다. 내 글을 보존했습니다.", message: "글 충돌 확인 필요" }); return;
      }
      update(value.date, { entry: latest, content: latest.content, loaded: true, error: "", message: "글을 저장했습니다." });
      setPending(null); setConflict(null);
    } catch (cause) {
      if (ownerRef.current === value.owner) update(value.date, { error: cause instanceof Error && !(cause instanceof TypeError) ? cause.message : "연결을 확인해주세요. 작성한 글과 저장 요청을 보존했습니다.", message: "글 저장 확인 필요" });
    } finally {
      if (ownerRef.current === value.owner) { operation.current = false; setBusy(false); }
      onOperationEnd?.();
    }
  }
  async function confirmSaved() {
    if (!pending || operation.current || busy || disabled) return;
    if (canStartOperation && !canStartOperation()) return;
    const value = pending; operation.current = true; setBusy(true);
    try {
      const latest = await read(value.date, value.owner);
      if (ownerRef.current !== value.owner) return;
      if (latest.content === value.content) {
        update(value.date, { entry: latest, content: latest.content, loaded: true, error: "", message: "글을 저장했습니다." }); setPending(null); setConflict(null);
      } else { setConflict(latest); update(value.date, { error: "저장된 글과 내 글이 다릅니다. 사용할 글을 선택해주세요.", message: "글 확인 필요" }); }
    } catch { if (ownerRef.current === value.owner) update(value.date, { error: "저장 여부를 확인하지 못했습니다. 작성한 글을 보존했습니다." }); }
    finally {
      if (ownerRef.current === value.owner) { operation.current = false; setBusy(false); }
      onOperationEnd?.();
    }
  }
  let validation = "";
  try { journalContent(page.content); } catch { validation = `글은 ${JOURNAL_MAX_LENGTH.toLocaleString("ko-KR")}자 이내로 입력해주세요. 사용할 수 없는 문자는 제거해주세요.`; }
  const inputDisabled = disabled || busy || Boolean(pending) || !page.loaded || page.loading || !ownerId;
  return <section className="journal-section" id={`${idPrefix}diary-journal`} aria-label="자유 기록">
    <header className="journal-heading"><p className="eyebrow">A LITTLE SPACE FOR YOU</p><h2>오늘의 기록</h2><p>{date} · 생각, 메모, 하루의 이야기를 담아보세요.</p></header>
    <form className="journal-form" onSubmit={event => {
      event.preventDefault(); if (inputDisabled || !dirty || validation) return;
      void send({ owner: ownerId, date, content: journalContent(page.content), version: page.entry.version, key: crypto.randomUUID(), startedAt: Date.now() });
    }}>
      <label htmlFor={`${idPrefix}journal-content`}>자유롭게 쓰는 글</label>
      <textarea id={`${idPrefix}journal-content`} value={page.content} disabled={inputDisabled} onChange={event => update(date, { content: event.target.value, error: "", message: "저장하지 않은 글이 있습니다." })}
        placeholder="떠오르는 생각부터 오늘의 이야기까지, 편하게 적어보세요." aria-invalid={Boolean(validation)} aria-describedby={`${idPrefix}journal-help${validation ? ` ${idPrefix}journal-validation` : ""}`} />
      <div className="journal-actions"><span className="journal-count">{[...page.content].length.toLocaleString("ko-KR")} / {JOURNAL_MAX_LENGTH.toLocaleString("ko-KR")}자</span><button type="submit" disabled={inputDisabled || !dirty || Boolean(validation)}>글 저장</button></div>
      <p id={`${idPrefix}journal-help`} className="field-note">날짜마다 기록이 따로 저장돼요. 작성 후 글 저장을 눌러주세요.{demo ? " 이 탭에 임시 저장됩니다." : ""}</p>
    </form>
    <p className="journal-save-status" aria-live="polite">{page.message}</p>
    {validation && <p id={`${idPrefix}journal-validation`} role="alert" className="error-note">{validation}</p>}
    {page.error && <p role="alert" className="error-note">{page.error}</p>}
    {!page.loaded && !page.loading && ownerId && <button type="button" disabled={disabled || busy} onClick={() => void load(date, ownerId)}>글 다시 불러오기</button>}
    {ownerId && pending && !busy && !conflict && <div className="journal-recovery"><button type="button" disabled={disabled} onClick={() => void send(pending)}>같은 글 다시 저장</button><button type="button" disabled={disabled} onClick={() => void confirmSaved()}>저장 여부 확인</button></div>}
    {ownerId && pending && conflict && <section className="journal-recovery" aria-label="글 충돌 확인"><h3>저장된 글</h3><pre>{conflict.content || "(빈 글)"}</pre><p>작성한 내 글은 위 입력란에 보존했습니다.</p>
      <button type="button" disabled={disabled || busy} onClick={() => { update(pending.date, { entry: conflict, content: conflict.content, error: "", message: "저장된 글을 불러왔습니다." }); setPending(null); setConflict(null); }}>저장된 글 사용</button>
      <button type="button" disabled={disabled || busy} onClick={() => void send({ ...pending, version: conflict.version, key: crypto.randomUUID(), startedAt: Date.now() })}>내 글 다시 저장</button></section>}
  </section>;
}
