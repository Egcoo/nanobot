import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CareerReferenceMaterials } from "@/components/career/CareerReferenceMaterials";
import type { CareerConversationData } from "@/lib/career-types";

afterEach(cleanup);

function materials(): CareerConversationData {
  return {
    thread_id: "preparation", truncated: false, analyses: [],
    preview: {
      resume: { id: "resume", name: "Data analysis resume", version: 3, text: "Availability: 4 days per week, 3 months.", profile: {} },
      job: { id: "job", name: "AI product internship", version: 1, text: "Build and evaluate AI products.", company: "Demo", requirements: {} },
      conditions: { days_per_week: 5, available_months: 5, available_from: null, locations: ["Shanghai"] },
      availability_conflicts: [], truncated: false,
      resume_condition_differences: [
        { field: "days_per_week", selected: 5, resume: 4, evidence: "Availability: 4 days per week, 3 months." },
        { field: "available_months", selected: 5, resume: 3, evidence: "Availability: 4 days per week, 3 months." },
      ],
    },
  };
}

it("shows selected availability and a sourced difference without changing either material", () => {
  const data = materials();
  const original = structuredClone(data);
  const onResumes = vi.fn(), onJobs = vi.fn();
  render(<CareerReferenceMaterials data={data} onResumes={onResumes} onJobs={onJobs} />);
  const note = screen.getByRole("note");
  expect(note).toHaveTextContent("Entered here: 5 days per week; resume: 4 days per week.");
  expect(note).toHaveTextContent("Entered here: 5 months; resume: 3 months.");
  expect(within(note).getByText('Resume excerpt: “Availability: 4 days per week, 3 months.”')).toBeVisible();
  const disclosure = screen.getByText("View reference materials").closest("details");
  expect(disclosure).not.toHaveAttribute("open");
  fireEvent.click(screen.getByText("View reference materials"));
  const availability = screen.getByRole("region", { name: "Availability for this preparation" });
  expect(availability).toHaveTextContent("5 days per week");
  expect(availability).toHaveTextContent("5 months");
  expect(availability).toHaveTextContent("Not provided");
  expect(availability).toHaveTextContent("Shanghai");
  fireEvent.click(screen.getByRole("button", { name: "Open resume library" }));
  fireEvent.click(screen.getByRole("button", { name: "Open job library" }));
  expect(onResumes).toHaveBeenCalledOnce(); expect(onJobs).toHaveBeenCalledOnce();
  expect(data).toEqual(original);
});

it("renders nonempty structured facts as readable values and retains unknown experience", () => {
  const data = materials();
  data.preview.resume_condition_differences = [];
  data.preview.resume.profile = { skills: ["Excel", "SQL"], interview_experience: null };
  data.preview.job.requirements = { days_per_week: 4 };
  render(<CareerReferenceMaterials data={data} onResumes={vi.fn()} onJobs={vi.fn()} />);
  fireEvent.click(screen.getByText("View reference materials"));
  const resume = screen.getByRole("region", { name: "Resume" });
  expect(resume).toHaveTextContent("Skills"); expect(resume).toHaveTextContent("Excel"); expect(resume).toHaveTextContent("SQL");
  expect(resume).toHaveTextContent("User interview experience"); expect(resume).toHaveTextContent("Not provided");
  expect(screen.getByRole("region", { name: "Job" })).toHaveTextContent("4 days per week");
});
