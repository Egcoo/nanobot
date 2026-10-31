import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fmtDateTime } from "@/lib/format-time";
import type { JobAction, JobVersion, JobWrite } from "@/lib/career-types";

interface Props {
  records: JobVersion[];
  activeVersionId?: string;
  busy: boolean;
  onSave: (action: JobAction, input: JobWrite) => Promise<JobVersion | undefined>;
  onConfirm: (id: string) => Promise<JobVersion | undefined>;
}

export function JobLibrary({ records, activeVersionId, busy, onSave, onConfirm }: Props) {
  const { t } = useTranslation();
  const [id, setId] = useState("");
  const [revising, setRevising] = useState(false);
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [text, setText] = useState("");
  const current = records.find((item) => item.id === id);
  const locked = current?.status === "confirmed" && !revising;
  const dirty = Boolean(current && (current.name !== name || (current.company ?? "") !== company || current.text !== text));

  function open(record?: JobVersion) {
    setId(record?.id ?? ""); setRevising(false);
    setName(record?.name ?? ""); setCompany(record?.company ?? ""); setText(record?.text ?? "");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const action = !current ? "career.job.create" : revising ? "career.job.revise" : "career.job.edit";
    const record = await onSave(action, {
      ...(current ? { id: current.id } : {}), name, company: company.trim() || null, text,
      requirements: current?.text === text ? current.requirements : {},
    });
    if (record) open(record);
  }

  return <div className="grid min-w-0 gap-5 lg:grid-cols-[13rem_minmax(0,1fr)]">
    <aside className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{t("career.jobVersions")}</span><span>{t("career.resumeCount", { count: records.length })}</span></div>
      <Button variant="outline" onClick={() => open()} disabled={busy} className="w-full">{t("career.addJob")}</Button>
      {records.length === 0 ? <p className="text-sm text-muted-foreground">{t("career.noJobs")}</p> :
        <ul aria-label={t("career.jobVersions")} className="space-y-2">{records.map((record) => <li key={record.id}>
          <button type="button" onClick={() => open(record)} disabled={busy} aria-pressed={id === record.id}
            className={`w-full rounded-xl border p-3 text-left disabled:opacity-50 ${id === record.id ? "border-primary bg-accent" : "border-border hover:bg-accent/50"}`}>
            <span className="block break-words font-medium">{record.name} · v{record.version}</span>
            {record.company ? <span className="block break-words text-xs text-muted-foreground">{record.company}</span> : null}
            <span className="text-xs text-muted-foreground">{t(`career.${record.status}`)} · {t("career.textSource")}</span>
            <span className="mt-1 block break-words text-xs text-muted-foreground">{t("career.addedAt")} <time dateTime={record.created_at}>{fmtDateTime(record.created_at)}</time></span>
            {record.id === activeVersionId ? <span className="mt-2 block w-fit rounded-full bg-orange-100 px-2 py-0.5 text-xs text-orange-900 dark:bg-orange-200/10 dark:text-orange-200">{t("career.currentUse")}</span> : null}
          </button>
        </li>)}</ul>}
    </aside>
    <form onSubmit={(event) => { void save(event); }} className="min-w-0 space-y-4 rounded-2xl border bg-muted/20 p-4 sm:p-5" aria-label={t("career.jobEditor")}>
      <h3 className="text-lg font-semibold">{current ? `${t("career.job")} · v${current.version}${revising ? ` · ${t("career.newVersion")}` : ""}` : t("career.addJob")}</h3>
      <p className="text-xs leading-relaxed text-muted-foreground">{t("career.viewOnlyHint")}</p>
      <label className="block space-y-1.5 text-sm"><span>{t("career.jobName")}</span>
        <Input value={name} onChange={(event) => setName(event.target.value)} required maxLength={500} disabled={busy || locked} />
      </label>
      <label className="block space-y-1.5 text-sm"><span>{t("career.company")}</span>
        <Input value={company} onChange={(event) => setCompany(event.target.value)} maxLength={500} disabled={busy || locked} />
      </label>
      <label className="block space-y-1.5 text-sm"><span>{t("career.jobText")}</span>
        <Textarea value={text} onChange={(event) => setText(event.target.value)} required maxLength={200000}
          readOnly={locked} disabled={busy} className="min-h-64 resize-y" />
      </label>
      <p className="text-xs leading-relaxed text-muted-foreground">{t(locked ? "career.confirmedHint" : "career.textHint")}</p>
      {current?.status === "draft" && dirty ? <p className="text-sm text-muted-foreground">{t("career.saveBeforeConfirm")}</p> : null}
      <div className="flex flex-wrap gap-2">
        {!locked ? <Button type="submit" disabled={busy || !name.trim() || !text.trim()}>{t("career.saveDraft")}</Button> : null}
        {locked ? <Button type="button" variant="outline" disabled={busy} onClick={() => setRevising(true)}>{t("career.saveNewVersion")}</Button> : null}
        {current?.status === "draft" && !revising ? <Button type="button" variant="outline" disabled={busy || dirty}
          onClick={() => { void onConfirm(current.id); }}>{t("career.confirm")}</Button> : null}
      </div>
    </form>
  </div>;
}
