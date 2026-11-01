import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, BriefcaseBusiness, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useClient } from "@/providers/ClientProvider";
import { ThreadVisibilityContext } from "@/hooks/useThreadVisibility";
import { ApiError } from "@/lib/api";
import {
  confirmCareerJob, confirmCareerResume, createCareerThread, fetchCareerState,
  fetchCareerWorkspaces, renameCareerResume, saveCareerJob, saveCareerResume,
  cancelCareerPlan, confirmCareerPlan, updateCareerTask,
} from "@/lib/career-api";
import type { CareerSelection, CareerState, CareerWorkspace } from "@/lib/career-types";
import { CAREER_SELECT_CLASS } from "./CareerTarget";
import { CareerHome } from "./CareerHome";
import { CareerNavigation, type CareerPage } from "./CareerNavigation";
import { JobLibrary } from "./JobLibrary";
import { PreparationList } from "./PreparationList";
import { ResumeLibrary } from "./ResumeLibrary";

interface Props {
  selection: CareerSelection;
  onSelectionChange: (selection: CareerSelection) => void;
  onBackToChat: () => void;
}

function errorKey(reason: unknown): string {
  if (reason instanceof ApiError) {
    if (reason.status === 400) return "invalidInput";
    if (reason.status === 404) return "notFound";
    if (reason.status === 409) return "conflict";
    if (reason.status === 503) return "storageError";
  }
  return "requestError";
}

export function CareerWorkbench(props: Props) {
  const { t } = useTranslation();
  const { webuiCapabilities } = useClient();
  const supported = webuiCapabilities.includes("webui.career.v1");
  return <section className="flex h-full min-w-0 flex-col" aria-label={t("career.title")}>
    {supported ? <CareerAvailable {...props} /> : <>
      <CareerHeader onBackToChat={props.onBackToChat} />
      <div className="m-6 rounded-xl border p-5" role="status">{t("career.unsupported")}</div>
    </>}
  </section>;
}

function CareerHeader({ onBackToChat, children }: { onBackToChat: () => void; children?: ReactNode }) {
  const { t } = useTranslation();
  return <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b px-4 py-3 sm:px-6">
    <div className="flex min-w-0 items-center gap-3">
      <Button variant="ghost" size="icon" onClick={onBackToChat} aria-label={t("career.backToChat")}><ArrowLeft className="h-4 w-4" /></Button>
      <BriefcaseBusiness className="h-5 w-5 shrink-0 text-orange-800 dark:text-orange-200" aria-hidden="true" />
      <div className="min-w-0"><h1 className="text-lg font-semibold">{t("career.title")}</h1><p className="text-xs text-muted-foreground">{t("career.subtitle")}</p></div>
    </div>
    {children}
  </header>;
}

function CareerAvailable({ selection, onSelectionChange, onBackToChat }: Props) {
  const { t } = useTranslation();
  const { client, getToken } = useClient();
  const [page, setPage] = useState<CareerPage>("workbench");
  const [epoch, setEpoch] = useState(0);
  const [catalog, setCatalog] = useState<{ owner: typeof client; items: CareerWorkspace[] } | null>(null);
  const [catalogError, setCatalogError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setCatalogError("");
    void fetchCareerWorkspaces(getToken(), controller.signal).then((items) => {
      if (!controller.signal.aborted) setCatalog({ owner: client, items });
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setCatalogError(errorKey(reason));
    });
    return () => controller.abort();
  }, [client, getToken, epoch]);
  const workspaces = catalog?.owner === client ? catalog.items : [];
  const reference = selection.workspaceRef || workspaces.find((item) => item.is_default)?.ref || "";
  const knownScope = workspaces.some((item) => item.ref === reference);
  return <>
    <CareerHeader onBackToChat={onBackToChat}>
      <div className="flex min-w-0 items-center gap-2">
        <label className="min-w-0 max-w-56 text-xs"><span className="sr-only">{t("career.workspace")}</span>
          <select className={`${CAREER_SELECT_CLASS} h-9 text-xs`} aria-label={t("career.workspace")} value={reference} disabled={workspaces.length === 0}
            onChange={(event) => { setPage("workbench"); onSelectionChange({ workspaceRef: event.target.value, threadId: "" }); }}>
            {!knownScope ? <option value={reference}>{t("career.choose")}</option> : null}
            {workspaces.map((workspace) => <option value={workspace.ref} key={workspace.ref}>{workspace.name}{workspace.is_default ? ` · ${t("career.defaultWorkspace")}` : ""}</option>)}
          </select>
        </label>
        <Button variant="ghost" size="icon" onClick={() => setEpoch((value) => value + 1)} aria-label={t("career.refresh")}><RefreshCw className="h-4 w-4" aria-hidden="true" /></Button>
      </div>
    </CareerHeader>
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-[1440px] p-4 sm:p-6 xl:px-8 xl:py-8">
      {catalogError ? <p role="alert" className="text-sm text-destructive">{t(`career.${catalogError}`)}</p> : null}
      {knownScope ? <CareerScope key={`${reference}:${selection.threadId}`} reference={reference} threadId={selection.threadId}
        page={page} setPage={setPage} epoch={epoch} onBackToChat={onBackToChat}
        onSelect={(threadId) => { setPage("workbench"); onSelectionChange({ workspaceRef: reference, threadId }); }} /> :
        <p role="status" className="text-sm text-muted-foreground">{t(workspaces.length === 0 ? "career.loading" : "career.notFound")}</p>}
      </div>
    </div>
  </>;
}

function CareerScope({ reference, threadId, page, setPage, onSelect, epoch, onBackToChat }: {
  reference: string; threadId: string; page: CareerPage; setPage: (page: CareerPage) => void;
  onSelect: (threadId: string) => void; epoch: number; onBackToChat: () => void;
}) {
  const { t } = useTranslation();
  const { client, getToken } = useClient();
  const [resource, setResource] = useState<{ owner: typeof client; value: CareerState } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preparationDraft, setPreparationDraft] = useState(0);
  const ownerRef = useRef({ client, live: true });
  if (ownerRef.current.client !== client) ownerRef.current = { client, live: true };
  const reads = useRef(0);
  useEffect(() => {
    const owner = ownerRef.current;
    owner.live = true;
    setBusy(false); setNotice(""); setError("");
    return () => { owner.live = false; };
  }, [client]);
  const load = useCallback(async (signal?: AbortSignal) => {
    const owner = ownerRef.current;
    const sequence = ++reads.current;
    try {
      const value = await fetchCareerState(getToken(), reference, signal);
      if (owner.live && ownerRef.current === owner && sequence === reads.current && !signal?.aborted) {
        setResource({ owner: client, value }); setError("");
      }
    } catch (reason) {
      if (owner.live && ownerRef.current === owner && sequence === reads.current && !signal?.aborted) {
        setResource(null); setError(errorKey(reason));
      }
    }
  }, [client, getToken, reference]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, epoch]);
  useEffect(() => client.onSessionUpdate((chatId, scope) => {
    if (chatId.startsWith("career-") && (scope === "metadata" || scope === "thread")) void load();
  }), [client, load]);
  const data = resource?.owner === client ? resource.value : null;
  const current = data?.threads.find((thread) => thread.id === threadId);
  useEffect(() => {
    if (threadId && data?.deleted_thread_ids?.includes(threadId)) onSelect("");
  }, [data, onSelect, threadId]);

  async function perform<T,>(operation: () => Promise<T>, noticeKey = "saved", conflictKey = "conflict"): Promise<T | undefined> {
    const owner = ownerRef.current;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await operation();
      if (ownerRef.current !== owner || !owner.live) return undefined;
      setNotice(noticeKey); await load();
      return ownerRef.current === owner && owner.live ? result : undefined;
    } catch (reason) {
      if (ownerRef.current === owner && owner.live) setError(errorKey(reason) === "conflict" ? conflictKey : errorKey(reason));
      return undefined;
    } finally {
      if (ownerRef.current === owner && owner.live) setBusy(false);
    }
  }

  return <div className="grid min-w-0 gap-6 xl:grid-cols-[11rem_minmax(0,1fr)] xl:gap-10" aria-busy={busy}>
    <CareerNavigation page={page} data={data} currentId={threadId} busy={busy} onNavigate={setPage} onSelect={onSelect}
      onNew={() => { setPreparationDraft((value) => value + 1); onSelect(""); }} />
    <div className="min-w-0 space-y-5">
    {error ? <p role="alert" className="text-sm text-destructive">{t(`career.${error}`)}</p> : null}
    {notice ? <p role="status" className="text-sm text-muted-foreground">{t(`career.${notice}`)}</p> : null}
    {!data ? (!error ? <p role="status">{t("career.loading")}</p> : null) : <>
      {threadId && !current ? <p role="alert" className="text-sm text-destructive">{t("career.notFound")}</p> : null}
      {page !== "workbench" ? <div className="space-y-3 pb-2">
        <p className="text-xs font-medium text-orange-800 dark:text-orange-200">{t("career.startEyebrow")}</p>
        <h2 className="text-2xl font-semibold tracking-tight">{t(`career.${page}`)}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{t(page === "resumes" ? "career.fileImportLater" : page === "jobs" ? "career.imageImportLater" : "career.tasksHint")}</p>
      </div> : null}
      <ThreadVisibilityContext.Provider value={page === "workbench"}><div hidden={page !== "workbench"}><CareerHome key={`${threadId}:${preparationDraft}`} data={data} thread={current} busy={busy}
        onNavigate={setPage} onBackToChat={onBackToChat}
        onConfirmPlan={async (id, tasks) => {
          const plan = await perform(() => confirmCareerPlan(client, reference, threadId, id, tasks), "planSaved", "planConflict");
          if (plan) setPage("tasks");
        }}
        onCancelPlan={async (id) => { await perform(() => cancelCareerPlan(client, reference, threadId, id), "draftCancelled", "planConflict"); }}
        onCreate={async (resumeId, jobId, conditions) => {
          const thread = await perform(() => createCareerThread(client, reference, resumeId, jobId, conditions));
          if (thread) onSelect(thread.id);
        }} /></div></ThreadVisibilityContext.Provider>
      <div hidden={page !== "resumes"}><ResumeLibrary records={data.resumes} busy={busy}
        activeVersionId={current?.resume_version_id}
        onSave={(action, input) => perform(() => saveCareerResume(client, reference, action, input))}
        onConfirm={(id) => perform(() => confirmCareerResume(client, reference, id))}
        onRename={(id, name, notes) => perform(() => renameCareerResume(client, reference, id, name, notes))} /></div>
      <div hidden={page !== "jobs"}><JobLibrary records={data.jobs} busy={busy}
        activeVersionId={current?.job_version_id}
        onSave={(action, input) => perform(() => saveCareerJob(client, reference, action, input))}
        onConfirm={(id) => perform(() => confirmCareerJob(client, reference, id))} /></div>
      <section hidden={page !== "tasks"} aria-label={t("career.tasks")}><PreparationList data={data} thread={current} busy={busy} onChoose={() => setPage("workbench")}
        onUpdate={async (id, status, result) => Boolean(await perform(() => updateCareerTask(client, reference, threadId, id, status, result), "saved", "planConflict"))} /></section>
    </>}
    </div>
  </div>;
}
