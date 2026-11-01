import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Send, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ThreadMessages } from "@/components/thread/ThreadMessages";
import { RecoveryNotice } from "@/components/thread/RecoveryNotice";
import { useNanobotStream } from "@/hooks/useNanobotStream";
import { useClient } from "@/providers/ClientProvider";
import { fetchCareerConversation } from "@/lib/career-api";
import type { CareerConversationData, CareerThread } from "@/lib/career-types";
import { projectWebuiThreadMessages } from "@/lib/thread-display-projection";
import { CareerReferenceMaterials } from "./CareerReferenceMaterials";

export function CareerConversation({ reference, thread, onResumes, onJobs }: {
  reference: string; thread: CareerThread; onResumes: () => void; onJobs: () => void;
}) {
  const { t } = useTranslation();
  const { client, getToken } = useClient();
  const [epoch, setEpoch] = useState(0);
  const refresh = useCallback(() => setEpoch((value) => value + 1), []);
  const [resource, setResource] = useState<{ owner: typeof client; value: CareerConversationData } | null>(null);
  const [error, setError] = useState(false);
  const [text, setText] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const chatId = thread.session_key.slice("websocket:".length);
  const stream = useNanobotStream(chatId, undefined, false, refresh, undefined, undefined, { key: thread.session_key });
  const displayMessages = useMemo(() => projectWebuiThreadMessages(stream.messages), [stream.messages]);
  useEffect(() => client.onSessionUpdate((updatedId) => { if (updatedId === chatId) refresh(); }), [chatId, client, refresh]);
  const lastAssistantTurn = [...stream.messages].reverse().find((message) => message.role === "assistant" && message.turnId)?.turnId;
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    void fetchCareerConversation(getToken(), reference, thread.id, controller.signal).then((value) => {
      if (!controller.signal.aborted) setResource({ owner: client, value });
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [client, getToken, reference, thread.id, epoch, lastAssistantTurn]);
  const data = resource?.owner === client && resource.value.thread_id === thread.id ? resource.value : null;
  useEffect(() => {
    if (scroll.current && follow.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [stream.messages]);
  function submit() {
    if (!text.trim() || !data || error || stream.isStreaming || !stream.messagesReady || stream.history.loading || stream.history.error) return;
    if (stream.send(text.trim())) { setText(""); follow.current = true; }
  }
  return <section aria-label={t("career.conversation")} className="flex min-h-[30rem] flex-col overflow-hidden rounded-2xl border bg-card/40">
    <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
      <h3 className="text-sm font-medium">{t("career.conversation")}</h3>
      <Button type="button" variant="ghost" size="sm" className="gap-2" onClick={() => { refresh(); stream.refreshHistory(); }}>
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />{t("career.refresh")}
      </Button>
    </header>
    {data ? <CareerReferenceMaterials data={data} onResumes={onResumes} onJobs={onJobs} /> : null}
    {error || stream.history.error ? <div role="alert" className="px-4 py-3 text-sm text-destructive">{t("career.chatLoadError")}</div> : null}
    {stream.streamError ? <div role="alert" className="px-4 py-3 text-sm text-destructive">{t("career.chatFailure")}</div> : null}
    {stream.recoveryState ? <RecoveryNotice state={stream.recoveryState} onContinue={stream.continueRecovery} onDismiss={stream.dismissRecovery} /> : null}
    <div ref={scroll} className="max-h-[65dvh] min-h-60 flex-1 overflow-y-auto px-2 py-4 sm:px-4"
      onScroll={() => { const pane = scroll.current; if (pane) follow.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 100; }}>
      {stream.history.hasMoreBefore ? <Button variant="ghost" size="sm" disabled={stream.history.loadingOlder} onClick={() => { follow.current = false; void stream.loadOlder(); }}>{t("career.olderMessages")}</Button> : null}
      {stream.history.loading || !data ? <p role="status" className="p-3 text-sm text-muted-foreground">{t("career.loading")}</p> : null}
      {displayMessages.length ? <ThreadMessages messages={displayMessages} isStreaming={stream.isStreaming} runStartedAt={stream.runStartedAt} retryStatus={stream.retryStatus}
        afterUserMessage={(message) => {
          const source = data?.analyses.find((item) => item.turn_id === message.turnId);
          return source ? <p className="mx-auto mb-3 max-w-3xl px-4 text-xs leading-relaxed text-muted-foreground" data-testid="career-turn-source" data-analysis-status={source.status}>
            {t("career.replyMaterials", { resume: source.resume_name, resumeVersion: source.resume_version, job: source.job_name, jobVersion: source.job_version })}
          </p> : null;
        }} /> : !stream.history.loading && data ? <p className="p-3 text-sm leading-relaxed text-muted-foreground">{t("career.chatWelcome")}</p> : null}
    </div>
    <form className="space-y-3 border-t p-4" onSubmit={(event) => { event.preventDefault(); submit(); }} aria-label={t("career.conversation")}>
      <Textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={2000}
        aria-label={t("career.chatInput")} placeholder={t("career.conversationPlaceholder")}
        disabled={!data || error || !stream.messagesReady || stream.history.loading || !!stream.history.error}
        onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }}
        className="min-h-24 resize-y" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">{t("career.chatScopeHint")}</p>
        {stream.isStreaming ? <Button type="button" variant="outline" onClick={stream.stop} className="gap-2"><Square className="h-3.5 w-3.5" aria-hidden="true" />{t("career.stop")}</Button> :
          <Button type="submit" disabled={!text.trim() || !data || error || !stream.messagesReady || stream.history.loading || !!stream.history.error} className="gap-2 bg-[#efb08f] text-[#30221a] hover:bg-[#e5a07d]"><Send className="h-3.5 w-3.5" aria-hidden="true" />{t("career.send")}</Button>}
      </div>
    </form>
  </section>;
}
