import { afterEach, expect, it, vi } from "vitest";
import { fetchCareerState, fetchCareerWorkspaces, saveCareerJob } from "@/lib/career-api";

afterEach(() => vi.unstubAllGlobals());

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
])("rejects malformed or wrong-workspace read responses before rendering", async (payload) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } })));
  await expect(fetchCareerState("engineering-token", "workspace")).rejects.toThrow("career_invalid_response");
});
