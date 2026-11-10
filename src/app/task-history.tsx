"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { activityTypeLabels, taskActivity, type TaskActivity, type TaskPlanSnapshot } from "@/domain/task-history";
import type { PlannerSession } from "./planner";

const statusLabels = { open: "진행 전", completed: "완료", deferred: "미룸", canceled: "취소" };
const fields = [["scheduledDate", "실행일"], ["dueDate", "마감일"], ["status", "상태"]] as const;
function valueLabel(snapshot: TaskPlanSnapshot, key: keyof TaskPlanSnapshot) {
  return key === "status" ? statusLabels[snapshot.status] : snapshot[key] ?? "없음";
}

export function TaskHistory({ taskId, ownerId, timezone, disabled, request, verifySession }: {
  taskId: string; ownerId: string; timezone: string; disabled: boolean;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  verifySession: () => Promise<PlannerSession>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false), [items, setItems] = useState<TaskActivity[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const generation = useRef(0), running = useRef(false), controller = useRef<AbortController | null>(null), failedCursor = useRef<string | null>(null);
  const load = useCallback(async (cursor: string | null = null) => {
    if (running.current) return;
    running.current = true; setBusy(true); setError(""); failedCursor.current = cursor;
    const sequence = ++generation.current;
    const abort = new AbortController(); controller.current = abort;
    try {
      const session = await verifySession();
      if (sequence !== generation.current || session.userId !== ownerId) return;
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const response = await request(`/api/tasks/${taskId}/activities?${query}`, { cache: "no-store", signal: abort.signal });
      if (!response.ok) throw new Error("계획 변경 이력을 불러오지 못했습니다. 다시 시도해주세요.");
      const page = await response.json();
      if (!Array.isArray(page.items) || !(page.nextCursor === null || typeof page.nextCursor === "string")) throw new Error("이력 응답을 확인할 수 없습니다. 다시 시도해주세요.");
      const values: TaskActivity[] = page.items.map(taskActivity);
      if (values.some(value => value.taskId !== taskId)) throw new Error("이력 응답을 확인할 수 없습니다. 다시 시도해주세요.");
      const confirmed = await verifySession();
      if (sequence !== generation.current || confirmed.userId !== ownerId) return;
      setItems(old => cursor ? [...new Map([...old, ...values].map(value => [value.id, value])).values()] : values);
      setNextCursor(page.nextCursor);
    } catch {
      if (sequence === generation.current) setError("계획 변경 이력을 불러오지 못했습니다. 다시 시도해주세요.");
    } finally {
      if (sequence === generation.current) { running.current = false; setBusy(false); controller.current = null; }
    }
  }, [ownerId, taskId, request, verifySession]);
  useEffect(() => {
    generation.current++; controller.current?.abort(); running.current = false;
    setItems([]); setNextCursor(null); setError(""); setBusy(false);
    if (open && !disabled) void load();
    return () => { generation.current++; controller.current?.abort(); running.current = false; };
  }, [open, disabled, load]);

  const dateLabel = (value: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  return <section className="task-history" aria-label="계획 변경 이력">
    <button type="button" aria-expanded={open} aria-controls={id} disabled={disabled} onClick={() => setOpen(value => !value)}>계획 변경 이력</button>
    {open && <div id={id} className="task-history-content">
      <p className="field-note">최근 변경부터 표시합니다. 시각 기준: {timezone}</p>
      {disabled ? <p role="status">현재 저장이나 계정 확인을 마친 뒤 이력을 다시 확인합니다.</p> : <>
        {!busy && !error && !items.length && <p className="field-note">아직 기록된 변경이 없습니다.</p>}
        <ol>{items.map(item => {
          const details = item.details;
          const changed = details ? fields.filter(([key]) => details.before === null || details.before[key] !== details.after[key]) : [];
          return <li key={item.id} data-activity-id={item.id}>
            <p className="history-heading"><strong>{activityTypeLabels[item.type]}</strong><time dateTime={item.occurredAt}>{dateLabel(item.occurredAt)}</time></p>
            {item.invalidatedBy && <p className="field-note">이 완료 기록은 이후 완료 취소로 무효화되었습니다.</p>}
            {!details ? <p className="field-note">이전 기록: 변경 전후 값 없음</p> : <>
              <ul className="history-changes">{changed.map(([key, label]) => <li key={key}>{label}: {details.before ? `${valueLabel(details.before, key)} → ` : ""}{valueLabel(details.after, key)}</li>)}</ul>
              {item.type === "completed" && <p className="field-note">완료 당시 실행일: {details.after.scheduledDate ?? "없음"} · 마감일: {details.after.dueDate ?? "없음"}</p>}
              {item.type === "order_changed" && <p className="field-note">날짜 안에서 할 일의 중요도 순서를 변경했습니다.</p>}
            </>}
          </li>;
        })}</ol>
        {busy && <p role="status">변경 이력을 불러오는 중입니다.</p>}
        {error && <div role="alert"><p>{error}</p><button type="button" disabled={busy} onClick={() => void load(failedCursor.current)}>이력 다시 불러오기</button></div>}
        {nextCursor && !error && <button type="button" disabled={busy} onClick={() => void load(nextCursor)}>이력 더 보기</button>}
      </>}
    </div>}
  </section>;
}
