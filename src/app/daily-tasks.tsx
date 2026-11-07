"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { title as normalizeTitle } from "@/domain/rules";
import type { TaskStatus } from "@/domain/task-options";
import type { PlannerTask } from "./planner";

export type InlineTaskEdit = { task: PlannerTask; title: string };
type Props = {
  tasks: PlannerTask[]; label: string; ready: boolean; disabled: boolean; hasMore: boolean;
  draft: string; onDraft: (value: string) => void; draftError: string;
  inline: InlineTaskEdit | null; onInline: (value: InlineTaskEdit | null) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  onCreate: (focusNext: boolean) => void; onRename: (task: PlannerTask, value: string) => void;
  onStatus: (task: PlannerTask, status: TaskStatus) => void;
  onMove: (task: PlannerTask, targetId: string) => void;
  onDragActive: (active: boolean) => void;
  onEdit: (task: PlannerTask) => void; onMore: () => void;
};
const symbols: Record<TaskStatus, string> = { open: "□", completed: "✓", deferred: "→", canceled: "×" };
const labels: Record<TaskStatus, string> = { open: "진행 전", completed: "완료", deferred: "미룸", canceled: "취소" };
type Drag = { task: PlannerTask; targetId: string; pointerId: number | null; startX: number; startY: number; moved: boolean; snapshot: string };

export function DailyTasks(props: Props) {
  const { tasks, label, ready, disabled, draft, onDraft, draftError, inline, onInline } = props;
  const [openStatus, setOpenStatus] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dragAnnouncement, setDragAnnouncement] = useState("");
  const dragRef = useRef<Drag | null>(null);
  const section = useRef<HTMLElement>(null);
  const menu = useRef<HTMLFieldSetElement>(null);
  const returnFocus = useRef<{ id: string; control: string } | null>(null);
  useEffect(() => {
    if (disabled || !returnFocus.current) return;
    const target = returnFocus.current; returnFocus.current = null;
    const control = document.getElementById(`${target.control}-${target.id}`);
    const row = document.getElementById(`status-${target.id}`)?.closest("li");
    if (control instanceof HTMLButtonElement && !control.disabled) control.focus();
    else row?.querySelector<HTMLInputElement>("input")?.focus();
  }, [disabled]);
  useEffect(() => { if (openStatus) menu.current?.querySelector("button")?.focus(); }, [openStatus]);
  useEffect(() => { if (disabled || inline) setOpenStatus(null); }, [disabled, inline]);
  function changeDrag(value: Drag | null) { dragRef.current = value; setDrag(value); }
  function finishDrag(commit: boolean) {
    const current = dragRef.current;
    if (!current) return;
    changeDrag(null); props.onDragActive(false);
    if (commit && current.targetId !== current.task.id) {
      returnFocus.current = { id: current.task.id, control: "drag" };
      setDragAnnouncement(`${current.task.title}의 순서를 저장합니다.`);
      props.onMove(current.task, current.targetId);
    } else setDragAnnouncement("순서 이동을 취소했습니다.");
  }
  // Cancel if a background change makes the captured row snapshot stale.
  useEffect(() => {
    if (dragRef.current && (disabled || inline || tasks.map(task => `${task.id}:${task.version}`).join(",") !== dragRef.current.snapshot)) {
      dragRef.current = null; setDrag(null); props.onDragActive(false); setDragAnnouncement("목록 상태가 바뀌어 이동을 취소했습니다.");
    }
  }, [tasks, disabled, inline, props.onDragActive]);
  function beginDrag(task: PlannerTask, pointerId: number | null, startX = 0, startY = 0) {
    setOpenStatus(null);
    changeDrag({ task, targetId: task.id, pointerId, startX, startY, moved: false, snapshot: tasks.map(item => `${item.id}:${item.version}`).join(",") });
    props.onDragActive(true);
    setDragAnnouncement(`${task.title} 선택. 원하는 줄로 끌거나 방향키로 이동한 뒤 Space 또는 Enter를 누르세요. Escape는 취소합니다.`);
  }
  function pointerTarget(event: PointerEvent<HTMLButtonElement>) {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return null;
    const element = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".daily-task-row[data-task-id]");
    if (!element || !section.current?.contains(element)) return null;
    const targetId = element.dataset.taskId;
    return tasks.some(task => task.id === targetId) ? targetId : null;
  }
  function dragKey(event: KeyboardEvent<HTMLButtonElement>, task: PlannerTask) {
    if (event.key === "Escape") { if (dragRef.current) { event.preventDefault(); finishDrag(false); } return; }
    if (event.key === "Tab") { finishDrag(false); return; }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (dragRef.current?.task.id === task.id) finishDrag(true);
      else beginDrag(task, null);
      return;
    }
    const current = dragRef.current;
    if (!current || current.pointerId !== null || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = tasks.findIndex(item => item.id === current.targetId);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tasks.length - 1 : Math.max(0, Math.min(tasks.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
    changeDrag({ ...current, targetId: tasks[next].id });
    setDragAnnouncement(`${next + 1}번째 줄로 이동합니다. Space 또는 Enter로 저장하세요.`);
  }
  let inlineError = "";
  if (inline) { try { normalizeTitle(inline.title); } catch { inlineError = "제목"; } }
  function closeOnEscape(event: KeyboardEvent, task: PlannerTask | undefined) {
    if (event.key !== "Escape" || !task || openStatus !== task.id) return;
    setOpenStatus(null); document.getElementById(`status-${task.id}`)?.focus(); event.preventDefault();
  }
  function row(task: PlannerTask | undefined, index: number) {
    const activeEmpty = !task && index === tasks.length && !props.hasMore;
    const activeEdit = Boolean(task && inline?.task.id === task.id);
    const inputDisabled = disabled || !ready || Boolean(drag) || Boolean(inline && !activeEdit) || (!task && !activeEmpty);
    const dirty = activeEdit && inline?.title !== inline?.task.title;
    const actionDisabled = disabled || !ready || Boolean(inline);
    const value = task ? activeEdit ? inline?.title ?? task.title : task.title : activeEmpty ? draft : "";
    const invalid = activeEdit ? Boolean(inlineError) : activeEmpty && Boolean(draftError);
    const commit = (focusNext = false) => {
      if (inputDisabled) return;
      if (task && dirty && inline && !inlineError) { if (focusNext) returnFocus.current = { id: task.id, control: "title" }; props.onRename(inline.task, inline.title); }
      if (!task && activeEmpty && draft.trim() && !draftError) props.onCreate(focusNext);
    };
    return <li key={task?.id ?? `empty-${index}`} className={`daily-task-row ${task?.status ?? "empty"}${task && drag?.task.id === task.id ? " is-dragging" : ""}${task && drag && drag.targetId === task.id ? " is-drop-target" : ""}`} data-task-id={task?.id}>
      <div className="daily-task-line">
        <fieldset className="daily-status-wrap" aria-label={`${index + 1}번째 할 일 상태`} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpenStatus(null); }}>
          <button type="button" id={task ? `status-${task.id}` : undefined} className="daily-status" onKeyDown={event => closeOnEscape(event, task)} disabled={!task || actionDisabled || Boolean(drag)}
            aria-label={task ? `${task.title} 상태 변경` : `${index + 1}번째 할 일 상태 변경`} aria-expanded={Boolean(task && openStatus === task.id)}
            aria-controls={task && openStatus === task.id ? `status-options-${task.id}` : undefined}
            onClick={() => task && setOpenStatus(openStatus === task.id ? null : task.id)}>
            <span className="bullet-symbol" aria-hidden="true">{task ? symbols[task.status] : "□"}</span>
            {task && <span className="sr-only">{labels[task.status]}</span>}
          </button>
          {task && openStatus === task.id && <fieldset ref={menu} id={`status-options-${task.id}`} aria-label={`${task.title} 상태 선택`} className="daily-status-menu">
            {([['completed', '완료'], ['deferred', '미루기'], ['open', '진행 전'], ['canceled', '취소']] as const).map(([status, text]) => <button key={status} type="button" onKeyDown={event => closeOnEscape(event, task)} aria-pressed={task.status === status} onClick={() => { setOpenStatus(null); returnFocus.current = { id: task.id, control: "status" }; props.onStatus(task, status); }}><span aria-hidden="true">{symbols[status]}</span>{text}</button>)}
          </fieldset>}
        </fieldset>
        <input ref={activeEmpty ? props.inputRef : undefined} aria-label={`${index + 1}번째 할 일`} value={value} disabled={inputDisabled} autoComplete="off"
          placeholder={activeEmpty ? "할 일을 적어보세요" : task ? "" : "앞줄을 입력하면 열려요"} aria-invalid={invalid} aria-describedby={invalid ? activeEdit ? "daily-edit-error" : "daily-draft-error" : "daily-task-help"}
          onChange={event => {
            if (task) onInline(event.target.value === (inline?.task.id === task.id ? inline.task.title : task.title) ? null : { task: inline?.task.id === task.id ? inline.task : task, title: event.target.value });
            else onDraft(event.target.value);
          }}
          onBlur={event => { if (!(event.relatedTarget instanceof HTMLElement && event.relatedTarget.closest(".daily-save-controls"))) commit(); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey && !invalid && value.trim() && (dirty || activeEmpty))) { event.preventDefault(); commit(true); }
          }} />
        <span className="daily-row-number"><span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span><span className="sr-only">{index + 1}순위</span></span>
        {task && !activeEdit && <div className="daily-row-actions">
          <button type="button" className="daily-drag-handle" id={`drag-${task.id}`} aria-label={`${task.title} 순서 이동`} aria-describedby="daily-drag-help" aria-pressed={drag?.task.id === task.id} title="끌어서 순서 이동" disabled={actionDisabled || Boolean(draft) || tasks.length < 2 || Boolean(drag && drag.task.id !== task.id)}
            onKeyDown={event => dragKey(event, task)} onBlur={() => { if (dragRef.current?.pointerId === null) finishDrag(false); }}
            onPointerDown={event => {
              if (event.button !== 0 || dragRef.current) return;
              event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
              beginDrag(task, event.pointerId, event.clientX, event.clientY);
            }}
            onPointerMove={event => {
              const current = dragRef.current;
              if (!current || current.pointerId !== event.pointerId) return;
              const moved = current.moved || Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 5;
              const targetId = pointerTarget(event);
              changeDrag({ ...current, targetId: targetId ?? current.targetId, moved });
            }}
            onPointerUp={event => {
              const current = dragRef.current;
              if (!current || current.pointerId !== event.pointerId) return;
              const targetId = pointerTarget(event);
              if (targetId) changeDrag({ ...current, targetId });
              finishDrag(Boolean(targetId && current.moved));
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            }} onPointerCancel={() => finishDrag(false)} onLostPointerCapture={() => finishDrag(false)}><span aria-hidden="true">⠿</span></button>
          <button type="button" disabled={actionDisabled || Boolean(drag)} aria-label={`${task.title} 수정`} onClick={() => props.onEdit(task)}>수정</button>
        </div>}
      </div>
      {(dirty || (activeEmpty && draft)) && <div className="daily-save-controls">
        <button type="button" disabled={inputDisabled || invalid || !value.trim()} onClick={() => commit(!task)}>할 일 저장</button>
        <button type="button" disabled={disabled} onClick={() => task ? onInline(null) : onDraft("")}>입력 되돌리기</button>
      </div>}
    </li>;
  }
  return <section ref={section} className="task-section daily-tasks" id="diary-scheduled" aria-label={label}>
    <div className="section-heading"><h2>{label}</h2><span className="task-count">{tasks.length}{props.hasMore ? "+" : ""} / 5</span></div>
    <p id="daily-task-help" className="field-note">Enter로 다음 줄 · 위에 놓을수록 중요한 일이에요.</p>
    <ol className="daily-task-lines">{Array.from({ length: 5 }, (_, index) => row(tasks[index], index))}</ol>
    <p className="field-note">□ 상태 선택 · ⠿을 끌어 순서 변경</p>
    <p id="daily-drag-help" className="sr-only">Space로 선택, 위아래 방향키로 위치 지정, Space 또는 Enter로 저장, Escape로 취소합니다.</p>
    <p className="sr-only daily-drag-status" aria-live="polite">{dragAnnouncement}</p>
    {draftError && <p id="daily-draft-error" className="error-note" role="alert">{draftError}</p>}
    {inlineError && <p id="daily-edit-error" className="error-note" role="alert">제목은 공백만 사용할 수 없으며 줄바꿈 없이 1~200자로 입력해주세요.</p>}
    {(tasks.length > 5 || props.hasMore) && <details className="daily-legacy"><summary className="daily-legacy-toggle">이전에 저장한 추가 할 일</summary><p className="field-note">기존 자료를 보존했어요. 날짜를 옮겨 정리할 수 있습니다.</p><ol>{tasks.slice(5).map((task, offset) => row(task, offset + 5))}</ol>{props.hasMore && <button type="button" disabled={disabled || Boolean(inline)} onClick={props.onMore}>더 보기</button>}</details>}
  </section>;
}
