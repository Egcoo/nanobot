import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { CareerState, CareerThread } from "@/lib/career-types";

export function PreparationList({ data, thread, onChoose }: {
  data: CareerState; thread?: CareerThread; onChoose: () => void;
}) {
  const { t } = useTranslation();
  const plans = new Set(data.plans.filter((plan) => plan.career_thread_id === thread?.id).map((plan) => plan.id));
  const tasks = data.tasks.filter((task) => plans.has(task.plan_id));
  if (!thread) return <div className="space-y-3 rounded-2xl border border-dashed p-6">
    <p>{t("career.chooseTargetFirst")}</p><Button variant="outline" onClick={onChoose}>{t("career.workbench")}</Button>
  </div>;
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">{t("career.tasksHint")}</p>
    {tasks.length === 0 ? <div className="rounded-2xl border border-dashed p-6"><p className="font-medium">{t("career.noTasks")}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t("career.noTasksHint")}</p></div> : <>
      <p className="text-sm">{t("career.progress", { completed: tasks.filter((task) => task.status === "completed").length, total: tasks.length })}</p>
      <ul className="space-y-3">{tasks.map((task) => <li key={task.id} className="space-y-2 rounded-xl border p-4">
        <div className="flex flex-wrap items-start justify-between gap-2"><h3 className="break-words font-medium">{task.title}</h3>
          <span className="text-xs text-muted-foreground">{t(`career.${task.status}`)}</span></div>
        <p className="whitespace-pre-wrap break-words text-sm">{task.action}</p>
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{t("career.criteria")}: {task.completion_criteria}</p>
        {task.result ? <p className="whitespace-pre-wrap break-words text-sm">{t("career.result")}: {task.result}</p> : null}
      </li>)}</ul>
    </>}
  </div>;
}
