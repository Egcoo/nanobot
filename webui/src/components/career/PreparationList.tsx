import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useClient } from "@/providers/ClientProvider";
import { fmtDateTime } from "@/lib/format-time";
import type { CareerState, CareerTask, CareerThread } from "@/lib/career-types";

function TaskCard({ task, editable, busy, onUpdate }: {
  task: CareerTask; editable: boolean; busy: boolean;
  onUpdate: (id: string, status: CareerTask["status"], result: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState({ base: task.result, value: task.result });
  const [pendingStatus, setPendingStatus] = useState<CareerTask["status"] | null>(null);
  const result = draft.base === task.result || draft.value !== draft.base ? draft.value : task.result;
  async function save(status: CareerTask["status"]) {
    setPendingStatus(status);
    try {
      if (await onUpdate(task.id, status, result)) setDraft({ base: result, value: result });
    } finally {
      setPendingStatus(null);
    }
  }
  return <li data-testid="career-task" className="min-w-0 space-y-3 rounded-xl border p-4">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <h3 className="break-words font-medium">{task.title}</h3>
      <span className="text-xs text-muted-foreground">{t(`career.${task.status}`)}</span>
    </div>
    <p className="whitespace-pre-wrap break-words text-sm">{task.action}</p>
    <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{t("career.criteria")}: {task.completion_criteria}</p>
    {task.basis ? <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{t("career.taskBasis")}: {task.basis}</p> : null}
    {editable ? <form aria-label={t("career.taskEditor", { title: task.title })} onSubmit={(event) => { event.preventDefault(); if (!busy) void save(task.status); }} className="space-y-3 border-t pt-3">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={(pendingStatus ?? task.status) === "completed"} disabled={busy || pendingStatus !== null}
        onChange={(event) => { void save(event.target.checked ? "completed" : "pending"); }} />{t("career.completeTask", { title: task.title })}</label>
      <label className="block space-y-1 text-sm"><span>{t("career.result")}</span><Textarea aria-label={t("career.result")} maxLength={20000} value={result} disabled={busy || pendingStatus !== null}
        onChange={(event) => setDraft({ base: task.result, value: event.target.value })} className="min-h-20" /></label>
      <Button type="submit" variant="outline" size="sm" disabled={busy || pendingStatus !== null || result === task.result}>{t("career.saveResult")}</Button>
    </form> : task.result ? <p className="whitespace-pre-wrap break-words text-sm">{t("career.result")}: {task.result}</p> : null}
  </li>;
}

export function PreparationList({ data, thread, busy, onChoose, onUpdate }: {
  data: CareerState; thread?: CareerThread; busy: boolean; onChoose: () => void;
  onUpdate: (id: string, status: CareerTask["status"], result: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const { webuiCapabilities } = useClient();
  const supported = webuiCapabilities.includes("webui.career.plans.v1");
  const plans = data.plans.filter((plan) => plan.career_thread_id === thread?.id);
  const ids = new Set(plans.map((plan) => plan.id));
  const tasks = data.tasks.filter((task) => ids.has(task.plan_id));
  const drafts = (data.drafts ?? []).filter((plan) => plan.career_thread_id === thread?.id);
  const available = !!thread && data.chat_available[thread.id] === true;
  if (!thread) return <div className="space-y-3 rounded-2xl border border-dashed p-6">
    <p>{t("career.chooseTargetFirst")}</p><Button variant="outline" onClick={onChoose}>{t("career.workbench")}</Button>
  </div>;
  return <div className="space-y-4">
    {supported && available && drafts.length > 0 ? <div className="space-y-2 rounded-xl border p-4">
      <p role="status" className="text-sm">{t("career.pendingDraftCount", { count: drafts.length })}</p>
      <Button type="button" variant="outline" onClick={onChoose}>{t("career.reviewDrafts")}</Button>
    </div> : null}
    {tasks.length === 0 ? <div className="space-y-3 rounded-2xl border border-dashed p-6"><p className="font-medium">{t("career.noTasks")}</p>
      <p className="text-sm text-muted-foreground">{t(!available ? "career.chatUnavailable" : supported ? "career.noTasksActionHint" : "career.noTasksHint")}</p>
      {supported && available ? <Button type="button" variant="outline" onClick={onChoose}>{t("career.returnToPlan")}</Button> : null}
    </div> : <>
      <p className="text-sm">{t("career.progress", { completed: tasks.filter((task) => task.status === "completed").length, total: tasks.length })}</p>
      {plans.map((plan) => <section key={plan.id} aria-label={t("career.savedPlan")} className="min-w-0 space-y-3">
        {plan.source ? <details className="rounded-lg border px-4 py-3 text-sm"><summary className="cursor-pointer font-medium">{t("career.planSource")}</summary>
          <p className="mt-2 break-words text-xs text-muted-foreground">{t("career.replyMaterials", { resume: plan.source.resume_name, resumeVersion: plan.source.resume_version, job: plan.source.job_name, jobVersion: plan.source.job_version })}</p>
          <p className="mt-1 text-xs text-muted-foreground"><time dateTime={plan.source.created_at}>{fmtDateTime(plan.source.created_at)}</time></p>
          {plan.source.reply_excerpt ? <p className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed">{plan.source.reply_excerpt}</p> : null}
        </details> : null}
        <ul className="space-y-3">{tasks.filter((task) => task.plan_id === plan.id).map((task) => <TaskCard key={task.id} task={task} busy={busy} editable={supported && available && !!plan.source} onUpdate={onUpdate} />)}</ul>
      </section>)}
    </>}
  </div>;
}
