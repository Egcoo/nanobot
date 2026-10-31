export interface CareerWorkspace { ref: string; name: string; is_default: boolean }

interface Version {
  id: string;
  version: number;
  parent_version_id: string | null;
  name: string;
  text: string;
  status: "draft" | "confirmed";
  source: "text";
  created_at: string;
}
export interface ResumeVersion extends Version { notes: string; profile: Record<string, unknown> }
export interface JobVersion extends Version { job_id: string; company: string | null; requirements: Record<string, unknown> }
export interface PersonalConditions {
  days_per_week: number | null;
  available_months: number | null;
  available_from?: string | null;
  locations: string[];
}
export interface CareerThread {
  id: string;
  workspace_id: string;
  session_key: string;
  resume_version_id: string;
  job_version_id: string;
  conditions: PersonalConditions;
}
export interface CareerPlan { id: string; analysis_id: string; career_thread_id: string; status: "confirmed" }
export interface CareerTask {
  id: string;
  plan_id: string;
  title: string;
  action: string;
  completion_criteria: string;
  status: "pending" | "completed";
  result: string;
}
export interface CareerState {
  workspace_ref: string;
  workspace_id: string;
  resumes: ResumeVersion[];
  jobs: JobVersion[];
  threads: CareerThread[];
  plans: CareerPlan[];
  tasks: CareerTask[];
  chat_available: Record<string, boolean>;
}
export interface CareerSelection { workspaceRef: string; threadId: string }
export interface ResumeWrite { id?: string; name: string; notes: string; text: string; profile: Record<string, unknown> }
export interface JobWrite { id?: string; name: string; company: string | null; text: string; requirements: Record<string, unknown> }
export type ResumeAction = "career.resume.create" | "career.resume.edit" | "career.resume.revise";
export type JobAction = "career.job.create" | "career.job.edit" | "career.job.revise";
