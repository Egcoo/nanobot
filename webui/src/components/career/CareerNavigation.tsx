import { BriefcaseBusiness, FileText, Home, ListChecks, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { CareerState } from "@/lib/career-types";

export type CareerPage = "workbench" | "resumes" | "jobs" | "tasks";

const PAGES = [
  { id: "workbench", icon: Home },
  { id: "resumes", icon: FileText },
  { id: "jobs", icon: BriefcaseBusiness },
  { id: "tasks", icon: ListChecks },
] as const;

export function CareerNavigation({ page, data, currentId, busy, onNavigate, onNew, onSelect }: {
  page: CareerPage; data: CareerState | null; currentId: string; busy: boolean;
  onNavigate: (page: CareerPage) => void; onNew: () => void; onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const count = { workbench: null, resumes: data?.resumes.length, jobs: data ? new Set(data.jobs.map((job) => job.job_id)).size : undefined, tasks: null };
  return <aside className="min-w-0 space-y-5 xl:sticky xl:top-0 xl:self-start">
    <Button variant="outline" className="w-full justify-start gap-2" disabled={busy || !data} onClick={onNew}>
      <Plus className="h-4 w-4" aria-hidden="true" />{t("career.newPreparation")}
    </Button>
    <nav aria-label={t("career.pages")} className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 xl:flex xl:flex-col">
      {PAGES.map(({ id, icon: Icon }) => <button key={id} type="button" aria-current={page === id ? "page" : undefined}
        onClick={() => onNavigate(id)}
        className={`flex min-h-11 min-w-0 items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${page === id ? "bg-orange-100/70 text-orange-900 dark:bg-orange-200/10 dark:text-orange-200" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}>
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /><span className="min-w-0 break-words">{t(`career.${id}`)}</span>
        {count[id] !== null && count[id] !== undefined ? <span className="ml-auto text-xs tabular-nums" aria-hidden="true">{count[id]}</span> : null}
      </button>)}
    </nav>
    <section aria-label={t("career.preparations")} className="border-t pt-4">
      <h2 className="mb-3 text-xs font-medium text-muted-foreground">{t("career.preparations")}</h2>
      {!data?.threads.length ? <p className="text-xs leading-relaxed text-muted-foreground">{t("career.noPreparations")}</p> :
        <ul className="max-h-48 space-y-1 overflow-y-auto xl:max-h-80">{data.threads.map((thread) => {
          const resume = data.resumes.find((item) => item.id === thread.resume_version_id);
          const job = data.jobs.find((item) => item.id === thread.job_version_id);
          return <li key={thread.id}><button type="button" disabled={busy} aria-pressed={currentId === thread.id} onClick={() => onSelect(thread.id)}
            className={`min-h-11 w-full rounded-lg px-3 py-2.5 text-left text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${currentId === thread.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50"}`}>
            <span className="block break-words font-medium">{resume?.name} · v{resume?.version} → {job?.name} · v{job?.version}</span>
            <span className="mt-1 block break-words text-muted-foreground">{t("career.conditionsSummary", { days: thread.conditions.days_per_week ?? t("career.unknown"), months: thread.conditions.available_months ?? t("career.unknown") })}</span>
          </button></li>;
        })}</ul>}
    </section>
  </aside>;
}
