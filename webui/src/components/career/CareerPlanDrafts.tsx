import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fmtDateTime } from "@/lib/format-time";
import type { CareerPlanDraft, CareerTaskInput } from "@/lib/career-types";

function DraftEditor({ plan, busy, onConfirm, onCancel }: {
  plan: CareerPlanDraft; busy: boolean;
  onConfirm: (id: string, tasks: CareerTaskInput[]) => Promise<void>; onCancel: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState(() => plan.proposed_tasks.map((task, index) => ({ ...task, key: index, selected: true })));
  const selected = items.filter((item) => item.selected);
  const ready = plan.source.analysis_status === "succeeded";
  const valid = selected.length > 0 && selected.every((item) => item.title.trim() && item.action.trim() && item.completion_criteria.trim() && item.basis.trim());
  function edit(key: number, patch: Partial<CareerTaskInput> & { selected?: boolean }) {
    setItems((current) => current.map((item) => item.key === key ? { ...item, ...patch } : item));
  }
  return <form aria-label={t("career.planDraftEditor")} onSubmit={(event) => event.preventDefault()} className="min-w-0 space-y-4 rounded-xl border border-orange-300/30 bg-orange-200/5 p-4">
    <div className="space-y-2">
      <h4 className="font-medium">{t("career.planDraft")}</h4>
      <p className="text-xs leading-relaxed text-muted-foreground">{t("career.draftHint")}</p>
      <p className="break-words text-xs text-muted-foreground">{t("career.replyMaterials", { resume: plan.source.resume_name, resumeVersion: plan.source.resume_version, job: plan.source.job_name, jobVersion: plan.source.job_version })}</p>
      <p className="text-xs text-muted-foreground"><time dateTime={plan.source.created_at}>{fmtDateTime(plan.source.created_at)}</time></p>
    </div>
    {!ready ? <p role="status" className="text-sm">{t("career.planGenerating")}</p> : null}
    <ol className="space-y-4">{items.map((item) => <li key={item.key} className="min-w-0 space-y-3 rounded-lg border bg-background/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={item.selected} disabled={busy} onChange={(event) => edit(item.key, { selected: event.target.checked })} />{t("career.selectPlanTask", { index: item.key + 1 })}</label>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setItems((current) => current.filter((task) => task.key !== item.key))}>{t("career.removePlanTask")}</Button>
      </div>
      <label className="block space-y-1 text-sm"><span>{t("career.taskTitle")}</span><Input value={item.title} maxLength={500} required={item.selected} disabled={busy || !item.selected} onChange={(event) => edit(item.key, { title: event.target.value })} /></label>
      <label className="block space-y-1 text-sm"><span>{t("career.taskAction")}</span><Textarea aria-label={t("career.taskAction")} value={item.action} maxLength={5000} required={item.selected} disabled={busy || !item.selected} onChange={(event) => edit(item.key, { action: event.target.value })} className="min-h-20" /></label>
      <label className="block space-y-1 text-sm"><span>{t("career.criteria")}</span><Textarea aria-label={t("career.criteria")} value={item.completion_criteria} maxLength={5000} required={item.selected} disabled={busy || !item.selected} onChange={(event) => edit(item.key, { completion_criteria: event.target.value })} className="min-h-20" /></label>
      <label className="block space-y-1 text-sm"><span>{t("career.taskBasis")}</span><Textarea aria-label={t("career.taskBasis")} value={item.basis} maxLength={2000} required={item.selected} disabled={busy || !item.selected} onChange={(event) => edit(item.key, { basis: event.target.value })} className="min-h-16" /></label>
    </li>)}</ol>
    {!selected.length ? <p className="text-sm text-muted-foreground">{t("career.noSelectedTasks")}</p> : null}
    <div className="flex flex-wrap gap-2">
      <Button type="button" disabled={busy || !ready || !valid} onClick={() => {
        if (!busy && ready && valid) void onConfirm(plan.id, selected.map(({ title, action, completion_criteria, basis }) => ({ title, action, completion_criteria, basis })));
      }}>{t("career.confirmPlan")}</Button>
      <Button type="button" variant="outline" disabled={busy} onClick={() => { void onCancel(plan.id); }}>{t("career.cancelPlan")}</Button>
    </div>
  </form>;
}

export function CareerPlanDrafts({ drafts, busy, onConfirm, onCancel }: {
  drafts: CareerPlanDraft[]; busy: boolean;
  onConfirm: (id: string, tasks: CareerTaskInput[]) => Promise<void>; onCancel: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  if (!drafts.length) return null;
  return <section aria-label={t("career.pendingPlans")} className="mt-5 space-y-4">
    <h3 className="px-2 text-sm font-medium">{t("career.pendingPlans")}</h3>
    {drafts.map((plan) => <DraftEditor key={plan.id} plan={plan} busy={busy} onConfirm={onConfirm} onCancel={onCancel} />)}
  </section>;
}
