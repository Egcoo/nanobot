import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { CareerConversationData } from "@/lib/career-types";

function hasFields(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasFields);
  if (value !== null && typeof value === "object") return Object.values(value).some(hasFields);
  return true;
}

function MaterialFields({ value }: { value: unknown }) {
  const { t } = useTranslation();
  if (Array.isArray(value)) return <ul className="list-inside list-disc space-y-1">{value.filter(hasFields).map((item, index) => <li key={index}><MaterialFields value={item} /></li>)}</ul>;
  if (value !== null && typeof value === "object") {
    const labels: Record<string, string> = {
      name: t("career.name"), education: t("career.education"), skills: t("career.skills"),
      project: t("career.projects"), projects: t("career.projects"), interview_experience: t("career.interviewExperience"),
      days_per_week: t("career.availabilityDays"), available_months: t("career.availabilityMonths"),
      available_from: t("career.availabilityDate"), locations: t("career.availabilityLocations"),
    };
    return <dl className="space-y-2">{Object.entries(value).filter(([, item]) => hasFields(item)).map(([key, item]) => <div key={key}>
      <dt className="font-medium">{labels[key] ?? key.replace(/[_-]+/g, " ")}</dt>
      <dd className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">{typeof item === "number" && (key === "days_per_week" || key === "available_months")
        ? t(key === "days_per_week" ? "career.daysValue" : "career.monthsValue", { count: item }) : <MaterialFields value={item} />}</dd>
    </div>)}</dl>;
  }
  return <>{value === null || value === "" ? t("career.unknown") : typeof value === "boolean" ? t(value ? "career.valueYes" : "career.valueNo") : String(value)}</>;
}

export function CareerReferenceMaterials({ data, onResumes, onJobs }: {
  data: CareerConversationData; onResumes: () => void; onJobs: () => void;
}) {
  const { t } = useTranslation();
  const { preview } = data;
  const conditions = preview.conditions;
  const formatCondition = (field: "days_per_week" | "available_months", count: number) => t(field === "days_per_week" ? "career.daysValue" : "career.monthsValue", { count });
  const differences = preview.resume_condition_differences ?? [];
  const rows = [
    [t("career.availabilityDays"), conditions.days_per_week === null ? t("career.unknown") : formatCondition("days_per_week", conditions.days_per_week)],
    [t("career.availabilityMonths"), conditions.available_months === null ? t("career.unknown") : formatCondition("available_months", conditions.available_months)],
    [t("career.availabilityDate"), conditions.available_from || t("career.unknown")],
    [t("career.availabilityLocations"), conditions.locations.join("、") || t("career.unknown")],
  ];
  return <>
    {differences.length ? <aside role="note" className="space-y-2 border-b border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
      <p className="font-medium">{t("career.conditionMismatch")}</p>
      <p className="text-xs leading-relaxed text-muted-foreground">{t("career.conditionMismatchHint")}</p>
      <ul className="space-y-2">{differences.map((item) => <li key={item.field} className="space-y-1">
        <p>{t("career.conditionComparison", { selected: formatCondition(item.field, item.selected), resume: formatCondition(item.field, item.resume) })}</p>
      </li>)}</ul>
      {[...new Set(differences.map((item) => item.evidence))].map((evidence) => <p key={evidence} className="break-words text-xs text-muted-foreground">{t("career.conditionEvidence", { text: evidence })}</p>)}
    </aside> : null}
    <details className="border-b px-4 py-3 text-sm" data-thread-disclosure>
      <summary className="cursor-pointer font-medium">{t("career.modelMaterials")}</summary>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t("career.privacyHint")}</p>
      {data.truncated ? <p role="status" className="mt-2 text-xs">{t("career.contextTruncated")}</p> : null}
      <section className="mt-4 space-y-3" aria-label={t("career.availabilityTitle")}>
        <h4 className="font-medium">{t("career.availabilityTitle")}</h4>
        <p className="text-xs text-muted-foreground">{t("career.availabilitySource")}</p>
        <dl className="grid min-w-0 gap-3 sm:grid-cols-2">{rows.map(([label, value]) => <div key={label} className="min-w-0 rounded-lg border p-3">
          <dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-words font-medium">{value}</dd>
        </div>)}</dl>
      </section>
      <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-2">
        {[{ item: preview.resume, label: t("career.resume"), action: onResumes, actionLabel: t("career.openResumeLibrary"), fields: preview.resume.profile, fieldsLabel: t("career.resumeFacts") },
          { item: preview.job, label: t("career.job"), action: onJobs, actionLabel: t("career.openJobLibrary"), fields: preview.job.requirements, fieldsLabel: t("career.jobFacts") }].map(({ item, label, action, actionLabel, fields, fieldsLabel }) => <section key={item.id} className="min-w-0 space-y-2" aria-label={label}>
            <h4 className="break-words font-medium">{item.name} · v{item.version}</h4>
            <p className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3 text-xs leading-relaxed">{item.text}</p>
            {hasFields(fields) ? <div className="space-y-2 rounded-lg border p-3 text-xs"><h5 className="font-medium">{fieldsLabel}</h5><MaterialFields value={fields} /></div> : null}
            <Button type="button" variant="outline" size="sm" onClick={action}>{actionLabel}</Button>
          </section>)}
      </div>
    </details>
  </>;
}
