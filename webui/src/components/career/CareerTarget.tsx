import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CareerState, CareerThread, PersonalConditions } from "@/lib/career-types";

export const CAREER_SELECT_CLASS = "h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function CareerTarget({ data, thread, busy, onCreate, onResumes, onJobs }: {
  data: CareerState; thread?: CareerThread; busy: boolean;
  onCreate: (resume: string, job: string, conditions: PersonalConditions) => Promise<void>;
  onResumes: () => void; onJobs: () => void;
}) {
  const { t } = useTranslation();
  const [resumeId, setResumeId] = useState(thread?.resume_version_id ?? "");
  const [jobId, setJobId] = useState(thread?.job_version_id ?? "");
  const [days, setDays] = useState(thread?.conditions.days_per_week?.toString() ?? "");
  const [months, setMonths] = useState(thread?.conditions.available_months?.toString() ?? "");
  const [locations, setLocations] = useState(thread?.conditions.locations.join("，") ?? "");
  const [choosing, setChoosing] = useState(!thread);
  const resumes = data.resumes.filter((record) => record.status === "confirmed");
  const jobs = data.jobs.filter((record) => record.status === "confirmed");
  const currentResume = data.resumes.find((record) => record.id === thread?.resume_version_id);
  const currentJob = data.jobs.find((record) => record.id === thread?.job_version_id);

  function create(event: FormEvent) {
    event.preventDefault();
    void onCreate(resumeId, jobId, {
      days_per_week: days ? Number(days) : null, available_months: months ? Number(months) : null,
      locations: locations.split(/[，,]/).map((item) => item.trim()).filter(Boolean),
    });
  }

  return <section className="min-w-0 space-y-4 rounded-2xl border bg-card/40 p-4 sm:p-5" aria-label={t("career.currentTarget")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t("career.currentTarget")}</h3>
        {thread ? <Button type="button" variant="ghost" size="sm" onClick={() => setChoosing((value) => !value)} aria-expanded={choosing}>
          {t(choosing ? "career.hideMaterials" : "career.changeMaterials")}
        </Button> : null}
      </div>
      {thread && currentResume && currentJob ? <>
        <p className="break-words">{currentResume.name} · v{currentResume.version} → {currentJob.name} · v{currentJob.version}</p>
        {currentJob.company ? <p className="text-sm text-muted-foreground">{currentJob.company}</p> : null}
        <p className="text-xs leading-relaxed text-muted-foreground">{t("career.conditionsSummary", { days: thread.conditions.days_per_week ?? t("career.unknown"), months: thread.conditions.available_months ?? t("career.unknown") })}
          {thread.conditions.locations.length ? ` · ${thread.conditions.locations.join("、")}` : ""}</p>
        <details className="text-sm"><summary className="cursor-pointer">{t("career.viewBoundMaterials")}</summary>
          <div className="mt-3 grid min-w-0 gap-4 lg:grid-cols-2">{[currentResume, currentJob].map((record) =>
            <div key={record.id} className="min-w-0"><h3 className="mb-2 font-medium">{record.name} · v{record.version}</h3>
              <p className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-background p-3">{record.text}</p></div>)}</div>
        </details>
        {!data.chat_available[thread.id] ? <p className="text-sm text-muted-foreground">{t("career.chatUnavailable")}</p> : null}
      </> : <p className="text-sm text-muted-foreground">{t("career.noTarget")}</p>}
    {resumes.length === 0 || jobs.length === 0 ? <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed p-4">
      <p className="w-full text-sm">{t("career.needConfirmed")}</p>
      <Button variant="outline" onClick={onResumes}>{t("career.resumes")}</Button>
      <Button variant="outline" onClick={onJobs}>{t("career.jobs")}</Button>
    </div> : <form onSubmit={create} hidden={!choosing} className="space-y-4 border-t pt-4" aria-label={t("career.chooseMaterials")}>
      <h4 className="text-sm font-medium">{t("career.chooseMaterials")}</h4>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <label className="min-w-0 space-y-1.5 text-sm"><span>{t("career.resumeVersion")}</span>
          <select className={CAREER_SELECT_CLASS} aria-label={t("career.resumeVersion")} value={resumeId} onChange={(event) => setResumeId(event.target.value)} required disabled={busy}>
            <option value="">{t("career.choose")}</option>{resumes.map((record) => <option key={record.id} value={record.id}>{record.name} · v{record.version}</option>)}
          </select>
        </label>
        <label className="min-w-0 space-y-1.5 text-sm"><span>{t("career.jobVersion")}</span>
          <select className={CAREER_SELECT_CLASS} aria-label={t("career.jobVersion")} value={jobId} onChange={(event) => setJobId(event.target.value)} required disabled={busy}>
            <option value="">{t("career.choose")}</option>{jobs.map((record) => <option key={record.id} value={record.id}>{record.name} · v{record.version}{record.company ? ` · ${record.company}` : ""}</option>)}
          </select>
        </label>
      </div>
      <details className="rounded-lg border p-3 text-sm">
        <summary className="cursor-pointer text-muted-foreground">{t("career.optionalConditions")}</summary>
        <div className="mt-3 grid min-w-0 gap-4 sm:grid-cols-2">
          <label className="min-w-0 space-y-1.5"><span>{t("career.days")}</span><Input type="number" value={days} min={1} max={7} step={1} disabled={busy} onChange={(event) => setDays(event.target.value)} /></label>
          <label className="min-w-0 space-y-1.5"><span>{t("career.months")}</span><Input type="number" value={months} min={1} step={1} disabled={busy} onChange={(event) => setMonths(event.target.value)} /></label>
          <label className="min-w-0 space-y-1.5 sm:col-span-2"><span>{t("career.locations")}</span><Input value={locations} maxLength={500} disabled={busy} onChange={(event) => setLocations(event.target.value)} /></label>
        </div>
      </details>
      <p className="text-xs text-muted-foreground">{t("career.bindingHint")}</p>
      <Button type="submit" disabled={busy || !resumeId || !jobId} className="max-w-full whitespace-normal bg-[#efb08f] text-[#30221a] hover:bg-[#e5a07d]">{t("career.enterPreparation")}</Button>
    </form>}
  </section>;
}
