import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CareerWorkbench } from "@/components/career/CareerWorkbench";
import * as api from "@/lib/career-api";
import type { CareerSelection, CareerState, ResumeVersion } from "@/lib/career-types";

const context = vi.hoisted(() => ({
  client: { requestMutation: vi.fn() }, token: "engineering-test-token", getToken: () => "engineering-test-token",
  webuiCapabilities: ["webui.core.v1", "webui.career.v1"],
}));
vi.mock("@/providers/ClientProvider", () => ({ useClient: () => context }));
vi.mock("@/lib/career-api", () => ({
  fetchCareerState: vi.fn(), fetchCareerWorkspaces: vi.fn(), saveCareerResume: vi.fn(),
  confirmCareerResume: vi.fn(), renameCareerResume: vi.fn(), saveCareerJob: vi.fn(),
  confirmCareerJob: vi.fn(), createCareerThread: vi.fn(),
}));

function empty(reference = "workspace-a"): CareerState {
  return { workspace_ref: reference, workspace_id: reference, resumes: [], jobs: [], threads: [], plans: [], tasks: [], chat_available: {} };
}
function resume(id: string, status: "draft" | "confirmed" = "draft"): ResumeVersion {
  return { id, name: `Resume ${id}`, text: `Text ${id}`, notes: "", version: 1, source: "text", created_at: "2026-10-30T08:00:00+00:00", parent_version_id: null, status, profile: {} };
}
function navigation(name: string) { return within(screen.getByRole("navigation", { name: "Career pages" })).getByRole("button", { name }); }
function Harness({ initialSelection = { workspaceRef: "", threadId: "" } }: { initialSelection?: CareerSelection }) {
  const [selection, setSelection] = useState<CareerSelection>(initialSelection);
  return <CareerWorkbench selection={selection} onSelectionChange={setSelection} onBackToChat={vi.fn()} />;
}

beforeEach(() => {
  vi.resetAllMocks();
  context.client = { requestMutation: vi.fn() };
  context.webuiCapabilities = ["webui.core.v1", "webui.career.v1"];
  vi.mocked(api.fetchCareerWorkspaces).mockResolvedValue([
    { ref: "workspace-a", name: "Project A", is_default: true },
    { ref: "workspace-b", name: "Project B", is_default: false },
  ]);
  vi.mocked(api.fetchCareerState).mockImplementation(async (_token, ref) => empty(ref));
});
afterEach(cleanup);

it("guides an empty workspace into real text entry while keeping the future conversation unavailable", async () => {
  render(<Harness />);
  await screen.findByRole("heading", { name: "Where will your job search begin?" });
  const conversation = screen.getByRole("region", { name: "Career conversation" });
  expect(within(conversation).getByRole("textbox")).toBeDisabled();
  expect(within(conversation).getByRole("button", { name: "Send" })).toBeDisabled();
  expect(within(conversation).getByText("Ordinary chat does not yet include these career materials.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Add resume" }));
  expect(screen.getByRole("form", { name: "Resume editor" })).toBeVisible();
  expect(screen.getByText("Paste resume text for now. PDF and DOCX import is not available yet.")).toBeVisible();
  fireEvent.click(navigation("Workbench"));
  fireEvent.click(screen.getByRole("button", { name: "Add job" }));
  expect(screen.getByRole("form", { name: "Job editor" })).toBeVisible();
  expect(screen.getByText("Paste job text for now. Screenshot recognition is not available yet.")).toBeVisible();
});

it("explains the unavailable optional feature on an independently defined old host without making career requests", () => {
  context.webuiCapabilities = ["webui.core.v1", "unknown.optional.capability"];
  const back = vi.fn();
  render(<CareerWorkbench selection={{ workspaceRef: "", threadId: "" }} onSelectionChange={vi.fn()} onBackToChat={back} />);
  expect(screen.getByRole("status")).toHaveTextContent("Ordinary chat remains available");
  fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
  expect(back).toHaveBeenCalledOnce();
  expect(api.fetchCareerWorkspaces).not.toHaveBeenCalled();
});

it("saves edited text before confirmation and keeps unsaved drafts while visiting another page", async () => {
  const state = empty();
  vi.mocked(api.fetchCareerState).mockResolvedValue(state);
  vi.mocked(api.saveCareerResume).mockImplementation(async (_transport, _ref, _action, input) => {
    const record = { ...resume("r1"), ...input, id: "r1" };
    state.resumes = [record]; return record;
  });
  vi.mocked(api.confirmCareerResume).mockImplementation(async () => {
    const record = { ...state.resumes[0], status: "confirmed" as const };
    state.resumes = [record]; return record;
  });
  render(<Harness />);
  await screen.findByText("No preparation selected.");
  fireEvent.click(navigation("Resumes"));
  const form = screen.getByRole("form", { name: "Resume editor" });
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Portfolio resume" } });
  fireEvent.change(within(form).getByLabelText("Resume text"), { target: { value: "First text" } });
  fireEvent.click(navigation("Jobs"));
  fireEvent.click(navigation("Resumes"));
  expect(within(form).getByLabelText("Resume text")).toHaveValue("First text");
  fireEvent.submit(form);
  await waitFor(() => expect(api.saveCareerResume).toHaveBeenCalledOnce());
  await waitFor(() => expect(within(form).getByRole("button", { name: "Confirm use" })).toBeEnabled());
  fireEvent.change(within(form).getByLabelText("Resume text"), { target: { value: "Edited text" } });
  expect(within(form).getByRole("button", { name: "Confirm use" })).toBeDisabled();
  fireEvent.submit(form);
  await waitFor(() => expect(within(form).getByRole("button", { name: "Confirm use" })).toBeEnabled());
  fireEvent.click(within(form).getByRole("button", { name: "Confirm use" }));
  await waitFor(() => expect(within(form).getByLabelText("Resume text")).toHaveAttribute("readonly"));
  expect(state.resumes[0].text).toBe("Edited text");
  expect(api.confirmCareerResume).toHaveBeenCalledWith(context.client, "workspace-a", "r1");
});

it("saves revisions separately and viewing another version does not change the preparation", async () => {
  const state = empty();
  const first = resume("r1", "confirmed"); const second = { ...resume("r2", "confirmed"), version: 2 };
  state.resumes = [first, second];
  state.jobs = [{ id: "j1", job_id: "job", version: 1, parent_version_id: null, name: "Job A", company: null,
    text: "Job text", requirements: {}, source: "text", created_at: "2026-10-30T08:00:00+00:00", status: "confirmed" }];
  state.threads = [{ id: "thread1", workspace_id: state.workspace_id, session_key: "websocket:thread1", resume_version_id: first.id,
    job_version_id: "j1", conditions: { days_per_week: 3, available_months: null, locations: [] } }];
  state.chat_available.thread1 = true;
  vi.mocked(api.fetchCareerState).mockResolvedValue(state);
  const change = vi.fn();
  vi.mocked(api.saveCareerResume).mockImplementation(async (_transport, _ref, _action, input) => {
    const record = { ...resume("r3"), ...input, id: "r3", version: 3, parent_version_id: first.id };
    state.resumes.push(record); return record;
  });
  render(<CareerWorkbench selection={{ workspaceRef: "workspace-a", threadId: "thread1" }} onSelectionChange={change} onBackToChat={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("region", { name: "Current preparation" })).toHaveTextContent("Resume r1 · v1 → Job A · v1"));
  fireEvent.click(navigation("Resumes"));
  fireEvent.click(within(screen.getByRole("list", { name: "Resume versions" })).getByRole("button", { name: /Resume r2/ }));
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("list", { name: "Resume versions" })).getByRole("button", { name: /Resume r1/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save as new version" }));
  const form = screen.getByRole("form", { name: "Resume editor" });
  fireEvent.change(within(form).getByLabelText("Resume text"), { target: { value: "New version text" } });
  fireEvent.submit(form);
  await waitFor(() => expect(api.saveCareerResume).toHaveBeenCalledWith(context.client, "workspace-a", "career.resume.revise", expect.objectContaining({ id: "r1", text: "New version text" })));
  expect(state.resumes[0].text).toBe("Text r1");
  expect(change).not.toHaveBeenCalled();
});

it("uses confirmed materials to enter a preparation and displays its real empty task state", async () => {
  const state = empty(); state.resumes = [resume("r1", "confirmed")];
  state.jobs = [{ id: "j1", job_id: "job", version: 1, parent_version_id: null, name: "Job A", company: null,
    text: "Job text", requirements: {}, source: "text", created_at: "2026-10-30T08:00:00+00:00", status: "confirmed" }];
  vi.mocked(api.fetchCareerState).mockResolvedValue(state);
  vi.mocked(api.createCareerThread).mockImplementation(async (_transport, _reference, resumeId, jobId, conditions) => {
    const thread = { id: "thread", workspace_id: state.workspace_id, session_key: "websocket:thread", resume_version_id: resumeId, job_version_id: jobId, conditions };
    state.threads.push(thread); state.chat_available.thread = true; return thread;
  });
  render(<Harness />);
  const form = await screen.findByRole("form", { name: "Choose materials" });
  fireEvent.change(within(form).getByLabelText("Resume version"), { target: { value: "r1" } });
  fireEvent.change(within(form).getByLabelText("Job version"), { target: { value: "j1" } });
  fireEvent.click(within(form).getByText("Availability (optional)"));
  fireEvent.change(within(form).getByLabelText("Days per week (optional)"), { target: { value: "3" } });
  fireEvent.submit(form);
  await waitFor(() => expect(screen.getByRole("region", { name: "Current preparation" })).toHaveTextContent("Resume r1 · v1 → Job A · v1"));
  expect(api.createCareerThread).toHaveBeenCalledWith(context.client, "workspace-a", "r1", "j1", expect.objectContaining({ days_per_week: 3 }));
  fireEvent.click(navigation("Preparation list"));
  expect(screen.getByText("No confirmed tasks")).toBeVisible();
  expect(screen.getByText("Saving suggestions from a conversation will be available in a later stage.")).toBeVisible();
});

it("ignores a delayed workspace response after a different workspace has been selected", async () => {
  let release: (value: CareerState) => void = () => {};
  const pending = new Promise<CareerState>((resolve) => { release = resolve; });
  const other = empty("workspace-b"); other.resumes = [{ ...resume("b"), name: "Project B resume" }];
  vi.mocked(api.fetchCareerState).mockImplementation(async (_token, ref) => ref === "workspace-a" ? pending : other);
  render(<Harness />);
  fireEvent.change(await screen.findByLabelText("Workspace"), { target: { value: "workspace-b" } });
  fireEvent.click(navigation("Resumes"));
  await screen.findByRole("button", { name: /Project B resume/ });
  const old = empty(); old.resumes = [{ ...resume("a"), name: "Project A private resume" }];
  await act(async () => release(old));
  expect(screen.getByRole("button", { name: /Project B resume/ })).toBeVisible();
  expect(screen.queryByRole("button", { name: /Project A private resume/ })).not.toBeInTheDocument();
});

it("discards the previous host's data when a different client takes ownership", async () => {
  const state = empty(); state.resumes = [{ ...resume("a"), name: "First host resume" }];
  vi.mocked(api.fetchCareerState).mockResolvedValue(state);
  const props = { selection: { workspaceRef: "workspace-a", threadId: "" }, onSelectionChange: vi.fn(), onBackToChat: vi.fn() };
  const view = render(<CareerWorkbench {...props} />);
  await screen.findByText("No preparation selected."); fireEvent.click(navigation("Resumes"));
  expect(screen.getByRole("button", { name: /First host resume/ })).toBeVisible();
  context.client = { requestMutation: vi.fn() };
  vi.mocked(api.fetchCareerState).mockResolvedValue(empty());
  view.rerender(<CareerWorkbench {...props} />);
  expect(screen.queryByRole("button", { name: /First host resume/ })).not.toBeInTheDocument();
  await screen.findByText("No resumes yet. Add a text draft to begin.");
});

it("keeps a late save response in its original workspace after switching", async () => {
  let finish: (value: ResumeVersion) => void = () => {};
  vi.mocked(api.saveCareerResume).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  render(<Harness />);
  await screen.findByText("No preparation selected."); fireEvent.click(navigation("Resumes"));
  const form = screen.getByRole("form", { name: "Resume editor" });
  fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Only project A" } });
  fireEvent.change(within(form).getByLabelText("Resume text"), { target: { value: "Project A text" } });
  fireEvent.submit(form);
  await waitFor(() => expect(api.saveCareerResume).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "workspace-b" } });
  await screen.findByText("No preparation selected."); fireEvent.click(navigation("Resumes"));
  await act(async () => finish({ ...resume("a"), name: "Only project A" }));
  expect(screen.getByRole("form", { name: "Resume editor" })).not.toHaveTextContent("Only project A");
  expect(screen.getByLabelText("Name")).toHaveValue("");
  expect(api.fetchCareerState).toHaveBeenLastCalledWith("engineering-test-token", "workspace-b", expect.any(AbortSignal));
});

it("shows confirmed tasks and progress only for the selected preparation", async () => {
  const state = empty(); state.resumes = [resume("r1", "confirmed")];
  state.jobs = [{ id: "j1", job_id: "job", version: 1, parent_version_id: null, name: "Job A", company: null,
    text: "Job text", requirements: {}, source: "text", created_at: "2026-10-30T08:00:00+00:00", status: "confirmed" }];
  state.threads = [{ id: "thread1", workspace_id: state.workspace_id, session_key: "websocket:thread1", resume_version_id: "r1",
    job_version_id: "j1", conditions: { days_per_week: null, available_months: null, locations: [] } }];
  state.plans = [{ id: "plan1", analysis_id: "a1", career_thread_id: "thread1", status: "confirmed" },
    { id: "plan2", analysis_id: "a2", career_thread_id: "another", status: "confirmed" }];
  state.tasks = [{ id: "t1", plan_id: "plan1", title: "Current task", action: "Prepare one page", completion_criteria: "One page ready", status: "completed", result: "Done" },
    { id: "t2", plan_id: "plan2", title: "Other target task", action: "Other", completion_criteria: "Other", status: "pending", result: "" }];
  vi.mocked(api.fetchCareerState).mockResolvedValue(state);
  render(<Harness initialSelection={{ workspaceRef: "workspace-a", threadId: "thread1" }} />);
  await screen.findByRole("region", { name: "Current preparation" }); fireEvent.click(navigation("Preparation list"));
  expect(screen.getByText("Current task")).toBeVisible();
  expect(within(screen.getByRole("region", { name: "Preparation list" })).getByText("1 of 1 completed")).toBeVisible();
  expect(screen.queryByText("Other target task")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "New preparation" }));
  expect(await screen.findByText("No preparation selected.")).toBeVisible();
  expect(api.createCareerThread).not.toHaveBeenCalled();
  expect(state.threads).toHaveLength(1);
  expect(state.tasks[0].status).toBe("completed");
  fireEvent.click(within(screen.getByRole("region", { name: "Preparation records" })).getByRole("button", { name: /Resume r1/ }));
  await waitFor(() => expect(screen.getByRole("region", { name: "Current preparation" })).toHaveTextContent("Resume r1 · v1 → Job A · v1"));
  fireEvent.click(navigation("Preparation list"));
  expect(within(screen.getByRole("region", { name: "Preparation list" })).getByText("1 of 1 completed")).toBeVisible();
});
