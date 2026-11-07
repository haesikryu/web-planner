"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
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
  onMove: (task: PlannerTask, direction: "up" | "down") => void;
  onEdit: (task: PlannerTask) => void; onMore: () => void;
};
const symbols: Record<TaskStatus, string> = { open: "□", completed: "✓", deferred: "→", canceled: "×" };
const labels: Record<TaskStatus, string> = { open: "진행 전", completed: "완료", deferred: "미룸", canceled: "취소" };

export function DailyTasks(props: Props) {
  const { tasks, label, ready, disabled, draft, onDraft, draftError, inline, onInline } = props;
  const [openStatus, setOpenStatus] = useState<string | null>(null);
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
  let inlineError = "";
  if (inline) { try { normalizeTitle(inline.title); } catch { inlineError = "제목"; } }
  function closeOnEscape(event: KeyboardEvent, task: PlannerTask | undefined) {
    if (event.key !== "Escape" || !task || openStatus !== task.id) return;
    setOpenStatus(null); document.getElementById(`status-${task.id}`)?.focus(); event.preventDefault();
  }
  function row(task: PlannerTask | undefined, index: number) {
    const activeEmpty = !task && index === tasks.length && !props.hasMore;
    const activeEdit = Boolean(task && inline?.task.id === task.id);
    const inputDisabled = disabled || !ready || Boolean(inline && !activeEdit) || (!task && !activeEmpty);
    const dirty = activeEdit && inline?.title !== inline?.task.title;
    const actionDisabled = disabled || !ready || Boolean(inline);
    const value = task ? activeEdit ? inline?.title ?? task.title : task.title : activeEmpty ? draft : "";
    const invalid = activeEdit ? Boolean(inlineError) : activeEmpty && Boolean(draftError);
    const commit = (focusNext = false) => {
      if (inputDisabled) return;
      if (task && dirty && inline && !inlineError) { if (focusNext) returnFocus.current = { id: task.id, control: "title" }; props.onRename(inline.task, inline.title); }
      if (!task && activeEmpty && draft.trim() && !draftError) props.onCreate(focusNext);
    };
    return <li key={task?.id ?? `empty-${index}`} className={`daily-task-row ${task?.status ?? "empty"}`} data-task-id={task?.id}>
      <div className="daily-task-line">
        <fieldset className="daily-status-wrap" aria-label={`${index + 1}번째 할 일 상태`} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpenStatus(null); }}>
          <button type="button" id={task ? `status-${task.id}` : undefined} className="daily-status" onKeyDown={event => closeOnEscape(event, task)} disabled={!task || actionDisabled}
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
      </div>
      {task && !activeEdit && <div className="daily-row-actions">
        <button type="button" id={`up-${task.id}`} aria-label={`${task.title} 위로 이동`} title="위로 이동 · 더 중요하게" disabled={actionDisabled || index === 0} onClick={() => { returnFocus.current = { id: task.id, control: "up" }; props.onMove(task, "up"); }}>↑</button>
        <button type="button" id={`down-${task.id}`} aria-label={`${task.title} 아래로 이동`} title="아래로 이동" disabled={actionDisabled || index === tasks.length - 1} onClick={() => { returnFocus.current = { id: task.id, control: "down" }; props.onMove(task, "down"); }}>↓</button>
        <button type="button" disabled={actionDisabled} onClick={() => props.onEdit(task)}>수정</button>
      </div>}
      {(dirty || (activeEmpty && draft)) && <div className="daily-save-controls">
        <button type="button" disabled={inputDisabled || invalid || !value.trim()} onClick={() => commit(!task)}>할 일 저장</button>
        <button type="button" disabled={disabled} onClick={() => task ? onInline(null) : onDraft("")}>입력 되돌리기</button>
      </div>}
    </li>;
  }
  return <section className="task-section daily-tasks" id="diary-scheduled" aria-label={label}>
    <div className="section-heading"><h2>{label}</h2><span className="task-count">{tasks.length}{props.hasMore ? "+" : ""} / 5</span></div>
    <p id="daily-task-help" className="field-note">앞줄부터 입력하고 Enter 또는 저장을 눌러주세요. 위에 놓을수록 중요한 일이에요.</p>
    <ol className="daily-task-lines">{Array.from({ length: 5 }, (_, index) => row(tasks[index], index))}</ol>
    <p className="field-note">□를 누르면 완료·미루기를 선택할 수 있어요. ↑↓로 중요도 순서를 바꾸세요.</p>
    {draftError && <p id="daily-draft-error" className="error-note" role="alert">{draftError}</p>}
    {inlineError && <p id="daily-edit-error" className="error-note" role="alert">제목은 공백만 사용할 수 없으며 줄바꿈 없이 1~200자로 입력해주세요.</p>}
    {(tasks.length > 5 || props.hasMore) && <details className="daily-legacy"><summary className="daily-legacy-toggle">이전에 저장한 추가 할 일</summary><p className="field-note">기존 자료를 보존했어요. 날짜를 옮겨 정리할 수 있습니다.</p><ol>{tasks.slice(5).map((task, offset) => row(task, offset + 5))}</ol>{props.hasMore && <button type="button" disabled={disabled || Boolean(inline)} onClick={props.onMore}>더 보기</button>}</details>}
  </section>;
}
