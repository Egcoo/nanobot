import { afterEach, expect, it, vi } from "vitest";
import { confirmCareerPlan, updateCareerTask, fetchCareerConversation, fetchCareerState, fetchCareerWorkspaces, saveCareerJob } from "@/lib/career-api";

afterEach(() => vi.unstubAllGlobals());

it("confirms an explicitly selected plan through the mutation transport and rejects a task reply for another preparation", async () => {
  const source = { turn_id: "turn", analysis_status: "succeeded", resume_name: "Resume", resume_version: 1,
    job_name: "Job", job_version: 1, created_at: "2026-11-01T08:00:00Z", reply_excerpt: "Advice" };
  const requestMutation = vi.fn().mockResolvedValue({ id: "plan", analysis_id: "analysis", career_thread_id: "thread", status: "confirmed", source });
  const tasks = [{ title: "Task", action: "Write one page", completion_criteria: "Page ready", basis: "Job asks for project evidence" }];
  await confirmCareerPlan({ requestMutation }, "workspace", "thread", "plan", tasks);
  expect(requestMutation).toHaveBeenCalledWith("career.plan.confirm", { workspace_ref: "workspace", thread_id: "thread", id: "plan", tasks }, expect.any(Number));
  requestMutation.mockResolvedValue({ id: "task", plan_id: "plan", career_thread_id: "other", title: "Task", action: "Action", completion_criteria: "Criteria", status: "completed", result: "Done" });
  await expect(updateCareerTask({ requestMutation }, "workspace", "thread", "task", "completed", "Done")).rejects.toThrow("career_invalid_response");
});

it("rejects a conversation response for another preparation before displaying its sources", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ thread_id: "other", preview: {}, analyses: [] }), { headers: { "content-type": "application/json" } })));
  await expect(fetchCareerConversation("engineering-token", "workspace", "current")).rejects.toThrow("career_invalid_response");
});

it("accepts existing conversation previews and validates the optional condition comparison before rendering", async () => {
  const payload = {
    thread_id: "current", truncated: false, analyses: [],
    preview: {
      resume: { id: "resume", name: "Resume", version: 1, text: "Resume text", profile: {} },
      job: { id: "job", name: "Job", version: 1, text: "Job text", company: "Demo", requirements: {} },
      conditions: { days_per_week: 5, available_months: 5, locations: [] },
      availability_conflicts: [], truncated: false,
    },
  };
  const read = (value: unknown) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })));
  read(payload);
  expect((await fetchCareerConversation("engineering-token", "workspace", "current")).preview.conditions.days_per_week).toBe(5);
  read({ ...payload, preview: { ...payload.preview, resume_condition_differences: [{ field: "days_per_week", selected: 5, resume: "four", evidence: "Availability: 4 days per week." }] } });
  await expect(fetchCareerConversation("engineering-token", "workspace", "current")).rejects.toThrow("career_invalid_response");
  read({ ...payload, preview: { ...payload.preview, conditions: { ...payload.preview.conditions, available_from: {} } } });
  await expect(fetchCareerConversation("engineering-token", "workspace", "current")).rejects.toThrow("career_invalid_response");
});

it("reads with the existing bearer authentication and abort signal", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ workspaces: [{ ref: "project", name: "Project", is_default: true }] }), { headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  expect(await fetchCareerWorkspaces("engineering-token", controller.signal)).toEqual([{ ref: "project", name: "Project", is_default: true }]);
  expect(fetch).toHaveBeenCalledWith("/api/career/workspaces", expect.objectContaining({ headers: { Authorization: "Bearer engineering-token" }, credentials: "same-origin" }));
});

it("saves through the shared mutation transport and preserves null company", async () => {
  const requestMutation = vi.fn().mockResolvedValue({ id: "job", job_id: "root", name: "Intern", version: 1, text: "Description", status: "draft", created_at: "2026-10-30T08:00:00+00:00", company: null, requirements: {} });
  await saveCareerJob({ requestMutation }, "workspace", "career.job.create", { name: "Intern", company: null, text: "Description", requirements: {} });
  expect(requestMutation).toHaveBeenCalledWith("career.job.create", { workspace_ref: "workspace", name: "Intern", company: null, text: "Description", requirements: {} }, expect.any(Number));
});

it.each([
  undefined,
  "not-a-date",
])("rejects unusable creation timestamps from a host before displaying version metadata", async (created_at) => {
  const requestMutation = vi.fn().mockResolvedValue({ id: "job", job_id: "root", name: "Intern", version: 1, text: "Description", status: "draft", company: null, requirements: {}, created_at });
  await expect(saveCareerJob({ requestMutation }, "workspace", "career.job.create", { name: "Intern", company: null, text: "Description", requirements: {} })).rejects.toThrow("career_invalid_response");
});

it.each([
  { workspace_ref: "wrong" },
  { workspace_ref: "workspace", workspace_id: "id", resumes: [], jobs: [], threads: [{ conditions: { days_per_week: {} } }], plans: [], tasks: [], chat_available: {} },
  { workspace_ref: "workspace", workspace_id: "id", resumes: [], jobs: [], threads: [], plans: [], tasks: [], chat_available: {}, deleted_thread_ids: [17] },
])("rejects malformed or wrong-workspace read responses before rendering", async (payload) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } })));
  await expect(fetchCareerState("engineering-token", "workspace")).rejects.toThrow("career_invalid_response");
});
