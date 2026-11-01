import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CareerPlanDrafts } from "@/components/career/CareerPlanDrafts";
import { PreparationList } from "@/components/career/PreparationList";
import type { CareerPlanDraft, CareerState, CareerTask } from "@/lib/career-types";

vi.mock("@/providers/ClientProvider", () => ({ useClient: () => ({ webuiCapabilities: ["webui.career.plans.v1"] }) }));
afterEach(cleanup);

function draft(): CareerPlanDraft {
  return { id: "plan", analysis_id: "analysis", career_thread_id: "thread", status: "draft",
    source: { turn_id: "turn", analysis_status: "succeeded", resume_name: "Resume A", resume_version: 2,
      job_name: "Job A", job_version: 1, created_at: "2026-11-01T08:00:00Z", reply_excerpt: "Grounded project advice" },
    proposed_tasks: [1, 2, 3].map((index) => ({ title: `Task ${index}`, action: `Action ${index}`, completion_criteria: `Criteria ${index}`, basis: `Basis ${index}` })),
  };
}

it("only confirms the edited selection through the explicit confirmation control", async () => {
  const plan = draft(), onConfirm = vi.fn(async () => {});
  render(<CareerPlanDrafts drafts={[plan]} busy={false} onConfirm={onConfirm} onCancel={vi.fn(async () => {})} />);
  const editor = screen.getByRole("form", { name: "Preparation draft editor" });
  fireEvent.change(within(editor).getAllByLabelText("Task title")[0], { target: { value: "Edited task" } });
  fireEvent.click(within(editor).getAllByRole("button", { name: "Remove item" })[1]);
  fireEvent.submit(editor);
  expect(onConfirm).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(within(editor).getByRole("button", { name: "Confirm and save tasks" })));
  expect(onConfirm).toHaveBeenCalledWith("plan", [{ ...plan.proposed_tasks[0], title: "Edited task" }, plan.proposed_tasks[2]]);
  expect(plan.proposed_tasks).toHaveLength(3);
  expect(plan.proposed_tasks[0].title).toBe("Task 1");
});

it("requires a nonempty selection and permits cancelling without confirming", async () => {
  const onConfirm = vi.fn(async () => {}), onCancel = vi.fn(async () => {});
  render(<CareerPlanDrafts drafts={[draft()]} busy={false} onConfirm={onConfirm} onCancel={onCancel} />);
  for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
  expect(screen.getByRole("button", { name: "Confirm and save tasks" })).toBeDisabled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel draft" })));
  expect(onCancel).toHaveBeenCalledWith("plan"); expect(onConfirm).not.toHaveBeenCalled();
});

it("retains edits while the original analysis finishes and enables confirmation afterwards", () => {
  const plan = draft(); plan.source.analysis_status = "running";
  const props = { busy: false, onConfirm: vi.fn(async () => {}), onCancel: vi.fn(async () => {}) };
  const view = render(<CareerPlanDrafts drafts={[plan]} {...props} />);
  fireEvent.change(screen.getAllByLabelText("Task title")[0], { target: { value: "Unsaved edit" } });
  expect(screen.getByRole("button", { name: "Confirm and save tasks" })).toBeDisabled();
  view.rerender(<CareerPlanDrafts drafts={[{ ...plan, source: { ...plan.source, analysis_status: "succeeded" } }]} {...props} />);
  expect(screen.getAllByLabelText("Task title")[0]).toHaveValue("Unsaved edit");
  expect(screen.getByRole("button", { name: "Confirm and save tasks" })).toBeEnabled();
});

const thread = { id: "thread", workspace_id: "workspace", session_key: "websocket:career-test", resume_version_id: "resume", job_version_id: "job",
  conditions: { days_per_week: 3, available_months: 3, locations: [] } };
function ProgressHarness({ change, acceptUpdate = true }: { change: (status: string, result: string) => void; acceptUpdate?: boolean }) {
  const [task, setTask] = useState<CareerTask>({ id: "task", plan_id: "plan", title: "Prepare project", action: "Write one page", completion_criteria: "One page ready", basis: "Job asks for project evidence", status: "pending", result: "" });
  const data: CareerState = { workspace_ref: "workspace", workspace_id: "workspace", resumes: [], jobs: [], threads: [thread], chat_available: { thread: true },
    plans: [{ id: "plan", analysis_id: "analysis", career_thread_id: "thread", status: "confirmed", source: draft().source }], tasks: [task] };
  return <PreparationList data={data} thread={thread} busy={false} onChoose={vi.fn()} onUpdate={async (_id, status, result) => {
    change(status, result);
    if (!acceptUpdate) return false;
    setTask((current) => ({ ...current, status, result })); return true;
  }} />;
}

it("saves progress and preserves the entered result when reopening a completed task", async () => {
  const change = vi.fn(); render(<ProgressHarness change={change} />);
  fireEvent.change(screen.getByLabelText("Result"), { target: { value: "One-page explanation completed" } });
  await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: "Completed: Prepare project" })));
  await waitFor(() => expect(screen.getByText("1 of 1 completed")).toBeVisible());
  await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: "Completed: Prepare project" })));
  expect(screen.getByText("0 of 1 completed")).toBeVisible();
  expect(screen.getByLabelText("Result")).toHaveValue("One-page explanation completed");
  expect(change).toHaveBeenLastCalledWith("pending", "One-page explanation completed");
});

it("rolls back a failed progress save while keeping the user's unsaved result", async () => {
  const change = vi.fn(); render(<ProgressHarness change={change} acceptUpdate={false} />);
  fireEvent.change(screen.getByLabelText("Result"), { target: { value: "Unsaved notes" } });
  await act(async () => fireEvent.click(screen.getByRole("checkbox", { name: "Completed: Prepare project" })));
  expect(screen.getByRole("checkbox", { name: "Completed: Prepare project" })).not.toBeChecked();
  expect(screen.getByText("0 of 1 completed")).toBeVisible();
  expect(screen.getByLabelText("Result")).toHaveValue("Unsaved notes");
  expect(change).toHaveBeenCalledWith("completed", "Unsaved notes");
});
