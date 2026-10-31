import { useId } from "react";
import { ArrowRight, ArrowUpRight, BriefcaseBusiness, FileText, MessageSquareText, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { CareerState, CareerThread, PersonalConditions } from "@/lib/career-types";
import type { CareerPage } from "./CareerNavigation";
import { CareerTarget } from "./CareerTarget";

export function CareerHome({ data, thread, busy, onNavigate, onCreate, onBackToChat }: {
  data: CareerState; thread?: CareerThread; busy: boolean;
  onNavigate: (page: CareerPage) => void;
  onCreate: (resume: string, job: string, conditions: PersonalConditions) => Promise<void>;
  onBackToChat: () => void;
}) {
  const { t } = useTranslation();
  const hintId = useId();
  const job = data.jobs.find((record) => record.id === thread?.job_version_id);
  const plans = new Set(data.plans.filter((plan) => plan.career_thread_id === thread?.id).map((plan) => plan.id));
  const tasks = data.tasks.filter((task) => plans.has(task.plan_id));
  const completed = tasks.filter((task) => task.status === "completed").length;
  const summaries = [
    { page: "resumes", value: t("career.resumeCount", { count: data.resumes.length }), hint: t("career.confirmedCount", { count: data.resumes.filter((record) => record.status === "confirmed").length }) },
    { page: "jobs", value: t("career.jobCount", { count: new Set(data.jobs.map((record) => record.job_id)).size }), hint: t("career.confirmedCount", { count: data.jobs.filter((record) => record.status === "confirmed").length }) },
    { page: "tasks", value: thread ? `${completed} / ${tasks.length}` : "—", hint: thread ? t("career.progress", { completed, total: tasks.length }) : t("career.chooseTargetFirst") },
  ] as const;
  return <div className="mx-auto max-w-4xl space-y-7">
    <div className="space-y-3 pt-1 sm:pt-3">
      <p className="text-xs font-medium tracking-wide text-orange-800 dark:text-orange-200">{t("career.startEyebrow")}</p>
      <h2 className="break-words text-2xl font-semibold tracking-tight sm:text-3xl">{job ? t("career.homeActiveTitle", { job: job.name }) : t("career.homeTitle")}</h2>
      <p className="text-sm leading-relaxed text-muted-foreground">{t("career.homeDescription")}</p>
    </div>
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
      {summaries.map((item) => <button key={item.page} type="button" onClick={() => onNavigate(item.page)}
        className="min-w-0 rounded-xl border bg-card/40 p-4 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="block text-xs text-muted-foreground">{t(`career.${item.page}`)}</span>
        <span className="mt-2 block text-lg font-semibold tabular-nums">{item.value}</span>
        <span className="mt-1 block break-words text-xs leading-relaxed text-muted-foreground">{item.hint}</span>
      </button>)}
    </div>
    <div className="grid min-w-0 gap-4 sm:grid-cols-2">
      <section className="min-w-0 space-y-3 rounded-2xl border bg-muted/20 p-5">
        <FileText className="h-5 w-5 text-orange-800 dark:text-orange-200" aria-hidden="true" />
        <h3 className="font-medium">{t("career.resumeIntro")}</h3>
        <p className="text-sm leading-relaxed text-muted-foreground">{t("career.resumeIntroHint")}</p>
        <Button variant="link" className="h-auto max-w-full gap-2 whitespace-normal p-0 text-orange-800 dark:text-orange-200" onClick={() => onNavigate("resumes")}>
          {t(data.resumes.length ? "career.resumes" : "career.addResume")}<ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
        </Button>
      </section>
      <section className="min-w-0 space-y-3 rounded-2xl border bg-muted/20 p-5">
        <BriefcaseBusiness className="h-5 w-5 text-orange-800 dark:text-orange-200" aria-hidden="true" />
        <h3 className="font-medium">{t("career.jobIntro")}</h3>
        <p className="text-sm leading-relaxed text-muted-foreground">{t("career.jobIntroHint")}</p>
        <Button variant="link" className="h-auto max-w-full gap-2 whitespace-normal p-0 text-orange-800 dark:text-orange-200" onClick={() => onNavigate("jobs")}>
          {t(data.jobs.length ? "career.jobs" : "career.addJob")}<ArrowRight className="h-4 w-4 shrink-0" aria-hidden="true" />
        </Button>
      </section>
    </div>
    <CareerTarget data={data} thread={thread} busy={busy} onCreate={onCreate}
      onResumes={() => onNavigate("resumes")} onJobs={() => onNavigate("jobs")} />
    <section aria-label={t("career.conversation")} className="min-w-0 rounded-2xl border bg-muted/20 p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <MessageSquareText className="h-4 w-4" aria-hidden="true" /><h3 className="text-sm font-medium">{t("career.conversation")}</h3>
        <span className="ml-auto rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{t("career.comingSoon")}</span>
      </div>
      <p id={hintId} className="mb-3 text-xs leading-relaxed text-muted-foreground">{t(thread ? "career.conversationReadyHint" : "career.conversationSetupHint")}</p>
      <Textarea disabled aria-label={t("career.conversationInput")} aria-describedby={hintId} placeholder={t("career.conversationPlaceholder")}
        className="min-h-24 resize-none border-0 bg-transparent p-0 text-sm shadow-none disabled:opacity-70" />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t pt-3">
        <Button variant="ghost" size="sm" onClick={onBackToChat} className="min-w-0 gap-1.5 whitespace-normal text-muted-foreground">
          {t("career.openOrdinaryChat")}<ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        </Button>
        <Button disabled size="sm" className="gap-2"><Send className="h-3.5 w-3.5" aria-hidden="true" />{t("career.send")}</Button>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t("career.ordinaryChatHint")}</p>
    </section>
  </div>;
}
