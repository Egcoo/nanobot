import { ApiError, API_READ_TIMEOUT_MS, mutation, request, type WebUIMutationTransport } from "@/lib/api";
import type {
  CareerState, CareerThread, CareerWorkspace, JobAction, JobVersion, JobWrite,
  PersonalConditions, ResumeAction, ResumeVersion, ResumeWrite,
  CareerConversationData,
  CareerPlan, CareerPlanSource, CareerTask, CareerTaskInput,
} from "@/lib/career-types";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(): never { throw new ApiError(502, "career_invalid_response"); }
function version(value: unknown): value is Record<string, unknown> {
  return record(value) && typeof value.id === "string" && typeof value.name === "string"
    && typeof value.text === "string" && Number.isInteger(value.version)
    && typeof value.created_at === "string" && Number.isFinite(Date.parse(value.created_at))
    && (value.status === "draft" || value.status === "confirmed");
}
function resume(value: unknown): value is ResumeVersion {
  return version(value) && typeof value.notes === "string" && record(value.profile);
}
function job(value: unknown): value is JobVersion {
  return version(value) && typeof value.job_id === "string"
    && (value.company === null || typeof value.company === "string") && record(value.requirements);
}
function thread(value: unknown): value is CareerThread {
  return record(value) && ["id", "workspace_id", "session_key", "resume_version_id", "job_version_id"]
    .every((field) => typeof value[field] === "string") && record(value.conditions)
    && ["days_per_week", "available_months"].every((field) => record(value.conditions)
      && (value.conditions[field] === null || Number.isInteger(value.conditions[field])))
    && Array.isArray(value.conditions.locations) && value.conditions.locations.every((item) => typeof item === "string");
}

function planSource(value: unknown): value is CareerPlanSource {
  return record(value) && (value.turn_id === null || typeof value.turn_id === "string")
    && ["queued", "running", "succeeded", "failed", "cancelled"].includes(String(value.analysis_status))
    && typeof value.resume_name === "string" && Number.isInteger(value.resume_version)
    && typeof value.job_name === "string" && Number.isInteger(value.job_version)
    && typeof value.created_at === "string" && Number.isFinite(Date.parse(value.created_at))
    && typeof value.reply_excerpt === "string";
}
function taskInput(value: unknown): value is CareerTaskInput {
  return record(value) && ["title", "action", "completion_criteria", "basis"].every((key) => typeof value[key] === "string");
}
function task(value: unknown): value is CareerTask {
  return record(value) && ["id", "plan_id", "title", "action", "completion_criteria", "result"].every((key) => typeof value[key] === "string")
    && (value.basis === undefined || typeof value.basis === "string") && (value.status === "pending" || value.status === "completed");
}

export async function fetchCareerWorkspaces(token: string, signal?: AbortSignal): Promise<CareerWorkspace[]> {
  const value = await request<unknown>("/api/career/workspaces", token, { signal }, API_READ_TIMEOUT_MS);
  if (!record(value) || !Array.isArray(value.workspaces)) return invalid();
  const workspaces: CareerWorkspace[] = [];
  for (const item of value.workspaces) {
    if (!record(item) || typeof item.ref !== "string" || typeof item.name !== "string" || typeof item.is_default !== "boolean") return invalid();
    workspaces.push({ ref: item.ref, name: item.name, is_default: item.is_default });
  }
  return workspaces;
}

export async function fetchCareerState(token: string, reference: string, signal?: AbortSignal): Promise<CareerState> {
  const value = await request<unknown>(`/api/career?workspace_ref=${encodeURIComponent(reference)}`, token, { signal }, API_READ_TIMEOUT_MS);
  if (!record(value) || value.workspace_ref !== reference || typeof value.workspace_id !== "string"
    || !Array.isArray(value.resumes) || !value.resumes.every(resume)
    || !Array.isArray(value.jobs) || !value.jobs.every(job)
    || !Array.isArray(value.threads) || !value.threads.every(thread)
    || (value.deleted_thread_ids !== undefined && (!Array.isArray(value.deleted_thread_ids) || !value.deleted_thread_ids.every((item) => typeof item === "string")))
    || !Array.isArray(value.plans) || !value.plans.every((item) => record(item)
      && ["id", "analysis_id", "career_thread_id"].every((key) => typeof item[key] === "string") && item.status === "confirmed"
      && (item.source === undefined || planSource(item.source)))
    || (value.drafts !== undefined && (!Array.isArray(value.drafts) || !value.drafts.every((item) => record(item)
      && ["id", "analysis_id", "career_thread_id"].every((key) => typeof item[key] === "string") && item.status === "draft"
      && Array.isArray(item.proposed_tasks) && item.proposed_tasks.length > 0 && item.proposed_tasks.length <= 50
      && item.proposed_tasks.every(taskInput) && planSource(item.source))))
    || !Array.isArray(value.tasks) || !value.tasks.every(task)
    || !record(value.chat_available) || !Object.values(value.chat_available).every((item) => typeof item === "boolean")) return invalid();
  // All UI-consumed fields are checked at this transport boundary.
  return value as unknown as CareerState;
}

export async function saveCareerResume(transport: WebUIMutationTransport, reference: string, action: ResumeAction, payload: ResumeWrite): Promise<ResumeVersion> {
  const result = await mutation<unknown>(transport, action, { workspace_ref: reference, ...payload });
  return resume(result) ? result : invalid();
}
export async function confirmCareerResume(transport: WebUIMutationTransport, reference: string, id: string): Promise<ResumeVersion> {
  const result = await mutation<unknown>(transport, "career.resume.confirm", { workspace_ref: reference, id });
  return resume(result) ? result : invalid();
}
export async function renameCareerResume(transport: WebUIMutationTransport, reference: string, id: string, name: string, notes: string): Promise<ResumeVersion> {
  const result = await mutation<unknown>(transport, "career.resume.rename", { workspace_ref: reference, id, name, notes });
  return resume(result) ? result : invalid();
}
export async function saveCareerJob(transport: WebUIMutationTransport, reference: string, action: JobAction, payload: JobWrite): Promise<JobVersion> {
  const result = await mutation<unknown>(transport, action, { workspace_ref: reference, ...payload });
  return job(result) ? result : invalid();
}
export async function confirmCareerJob(transport: WebUIMutationTransport, reference: string, id: string): Promise<JobVersion> {
  const result = await mutation<unknown>(transport, "career.job.confirm", { workspace_ref: reference, id });
  return job(result) ? result : invalid();
}
export async function createCareerThread(transport: WebUIMutationTransport, reference: string, resumeId: string, jobId: string, conditions: PersonalConditions): Promise<CareerThread> {
  const result = await mutation<unknown>(transport, "career.thread.create", { workspace_ref: reference, resume_version_id: resumeId, job_version_id: jobId, conditions });
  return thread(result) ? result : invalid();
}

export async function confirmCareerPlan(transport: WebUIMutationTransport, reference: string, threadId: string, planId: string, tasks: CareerTaskInput[]): Promise<CareerPlan> {
  const value = await mutation<unknown>(transport, "career.plan.confirm", { workspace_ref: reference, thread_id: threadId, id: planId, tasks });
  if (!record(value) || value.id !== planId || value.career_thread_id !== threadId || value.status !== "confirmed"
    || typeof value.analysis_id !== "string" || !planSource(value.source)) return invalid();
  return value as unknown as CareerPlan;
}
export async function cancelCareerPlan(transport: WebUIMutationTransport, reference: string, threadId: string, planId: string): Promise<void> {
  const value = await mutation<unknown>(transport, "career.plan.cancel", { workspace_ref: reference, thread_id: threadId, id: planId });
  if (!record(value) || value.id !== planId || value.career_thread_id !== threadId || value.status !== "cancelled") return invalid();
}
export async function updateCareerTask(transport: WebUIMutationTransport, reference: string, threadId: string, taskId: string, status: CareerTask["status"], result: string): Promise<CareerTask> {
  const value = await mutation<unknown>(transport, "career.task.update", { workspace_ref: reference, thread_id: threadId, id: taskId, status, result });
  return record(value) && value.career_thread_id === threadId && task(value) && value.id === taskId ? value : invalid();
}

export async function fetchCareerConversation(token: string, reference: string, threadId: string, signal?: AbortSignal): Promise<CareerConversationData> {
  const value = await request<unknown>(`/api/career/conversation?workspace_ref=${encodeURIComponent(reference)}&thread_id=${encodeURIComponent(threadId)}`, token, { signal }, API_READ_TIMEOUT_MS);
  if (!record(value) || value.thread_id !== threadId || typeof value.truncated !== "boolean"
    || !record(value.preview) || !record(value.preview.resume) || !record(value.preview.job)
    || ![value.preview.resume, value.preview.job].every((item) => typeof item.id === "string" && typeof item.name === "string" && typeof item.text === "string" && Number.isInteger(item.version))
    || !record(value.preview.resume.profile) || !record(value.preview.job.requirements) || typeof value.preview.job.company !== "string"
    || !record(value.preview.conditions) || !Array.isArray(value.preview.conditions.locations)
    || !value.preview.conditions.locations.every((item) => typeof item === "string")
    || (value.preview.conditions.available_from !== undefined && value.preview.conditions.available_from !== null && typeof value.preview.conditions.available_from !== "string")
    || !["days_per_week", "available_months"].every((key) => record(value.preview) && record(value.preview.conditions) && (value.preview.conditions[key] === null || Number.isInteger(value.preview.conditions[key])))
    || typeof value.preview.truncated !== "boolean" || !Array.isArray(value.preview.availability_conflicts)
    || !value.preview.availability_conflicts.every((item) => record(item) && typeof item.field === "string" && Number.isInteger(item.available) && Number.isInteger(item.required))
    || (value.preview.resume_condition_differences !== undefined && (!Array.isArray(value.preview.resume_condition_differences)
      || !value.preview.resume_condition_differences.every((item) => record(item)
        && ["days_per_week", "available_months"].includes(String(item.field))
        && Number.isInteger(item.selected) && Number.isInteger(item.resume)
        && typeof item.evidence === "string" && item.evidence.length <= 200)))
    || !Array.isArray(value.analyses) || !value.analyses.every((item) => record(item)
      && item.career_thread_id === threadId && typeof item.id === "string" && (item.turn_id === null || typeof item.turn_id === "string")
      && typeof item.resume_name === "string" && typeof item.job_name === "string" && typeof item.created_at === "string"
      && Number.isInteger(item.resume_version) && Number.isInteger(item.job_version)
      && ["queued", "running", "succeeded", "failed", "cancelled"].includes(String(item.status)))) return invalid();
  return value as unknown as CareerConversationData;
}
