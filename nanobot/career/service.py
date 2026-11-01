"""Career lifecycle rules. Calling confirmation methods is an explicit user action.

The future authenticated adapter must resolve host/workspace/session ownership before
constructing this service. This module neither creates chats nor invokes a model.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timezone
from enum import Enum
from typing import TypeVar
from uuid import uuid4

from pydantic import BaseModel, JsonValue, TypeAdapter

from nanobot.career.models import (
    AnalysisRun,
    AnalysisSnapshot,
    AnalysisStatus,
    CareerConflictError,
    CareerThread,
    JobVersion,
    PersonalConditions,
    PreparationPlan,
    PreparationTask,
    ResumeVersion,
    TaskInput,
    TaskList,
    TaskStatus,
)
from nanobot.career.store import CareerStore

_Record = TypeVar("_Record", bound=BaseModel)


class _Unchanged(Enum):
    COMPANY = 0


_TASK_LIST = TypeAdapter(TaskList)
_ANALYSIS_TRANSITIONS: dict[AnalysisStatus, frozenset[AnalysisStatus]] = {
    "queued": frozenset({"running", "failed", "cancelled"}),
    "running": frozenset({"succeeded", "failed", "cancelled"}),
    "failed": frozenset({"queued"}),
    "succeeded": frozenset(),
    "cancelled": frozenset(),
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _id(kind: str) -> str:
    return f"{kind}_{uuid4().hex}"


def _replace(record: _Record, **updates: object) -> _Record:
    # model_copy(update=...) skips validation; edits also cross an input boundary.
    values = record.model_dump()
    values.update(updates)
    return type(record).model_validate(values)


class CareerService:
    def __init__(self, store: CareerStore) -> None:
        self.store = store

    def create_resume(
        self, *, name: str, text: str, profile: dict[str, JsonValue] | None = None,
        notes: str = "",
    ) -> ResumeVersion:
        with self.store.transaction(write=True) as db:
            now = _now()
            record = ResumeVersion(
                id=_id("resume"), version=self.store.next_resume_version(db),
                name=name, notes=notes, text=text, profile=profile if profile is not None else {},
                created_at=now, updated_at=now,
            )
            self.store.add_resume(db, record)
            return record

    def get_resume(self, version_id: str) -> ResumeVersion:
        with self.store.transaction() as db:
            return self.store.resume(db, version_id)

    def list_resumes(self) -> list[ResumeVersion]:
        with self.store.transaction() as db:
            return self.store.resumes(db)

    def edit_resume_draft(
        self, version_id: str, *, text: str, profile: dict[str, JsonValue] | None = None,
        name: str | None = None, notes: str | None = None,
    ) -> ResumeVersion:
        with self.store.transaction(write=True) as db:
            current = self.store.resume(db, version_id)
            if current.status != "draft":
                raise CareerConflictError("confirmed resume content is immutable; save a new version")
            record = _replace(
                current, text=text, profile=profile if profile is not None else {}, updated_at=_now(),
                name=name if name is not None else current.name,
                notes=notes if notes is not None else current.notes,
            )
            self.store.update_resume(db, record)
            return record

    def revise_resume(
        self, version_id: str, *, text: str, profile: dict[str, JsonValue] | None = None,
        name: str | None = None, notes: str | None = None,
    ) -> ResumeVersion:
        with self.store.transaction(write=True) as db:
            previous = self.store.resume(db, version_id)
            now = _now()
            record = ResumeVersion(
                id=_id("resume"), version=self.store.next_resume_version(db),
                parent_version_id=previous.id,
                name=name if name is not None else previous.name,
                notes=notes if notes is not None else previous.notes,
                text=text, profile=profile if profile is not None else {},
                created_at=now, updated_at=now,
            )
            self.store.add_resume(db, record)
            return record

    def rename_resume(self, version_id: str, *, name: str, notes: str) -> ResumeVersion:
        with self.store.transaction(write=True) as db:
            record = _replace(
                self.store.resume(db, version_id), name=name, notes=notes, updated_at=_now(),
            )
            self.store.update_resume(db, record)
            return record

    def confirm_resume(self, version_id: str) -> ResumeVersion:
        with self.store.transaction(write=True) as db:
            current = self.store.resume(db, version_id)
            if current.status == "confirmed":
                return current
            now = _now()
            record = _replace(current, status="confirmed", confirmed_at=now, updated_at=now)
            self.store.update_resume(db, record)
            return record

    def create_job(
        self, *, name: str, text: str, company: str | None = None,
        requirements: dict[str, JsonValue] | None = None,
    ) -> JobVersion:
        with self.store.transaction(write=True) as db:
            now = _now()
            record = JobVersion(
                id=_id("job_version"), job_id=_id("job"), version=1,
                name=name, company=company, text=text,
                requirements=requirements if requirements is not None else {},
                created_at=now, updated_at=now,
            )
            self.store.add_job(db, record)
            return record

    def get_job(self, version_id: str) -> JobVersion:
        with self.store.transaction() as db:
            return self.store.job(db, version_id)

    def list_jobs(self) -> list[JobVersion]:
        with self.store.transaction() as db:
            return self.store.jobs(db)

    def edit_job_draft(
        self, version_id: str, *, name: str, company: str | None, text: str,
        requirements: dict[str, JsonValue] | None = None,
    ) -> JobVersion:
        with self.store.transaction(write=True) as db:
            current = self.store.job(db, version_id)
            if current.status != "draft":
                raise CareerConflictError("confirmed job content is immutable; save a new version")
            record = _replace(
                current, name=name, company=company, text=text,
                requirements=requirements if requirements is not None else {}, updated_at=_now(),
            )
            self.store.update_job(db, record)
            return record

    def revise_job(
        self, version_id: str, *, text: str, requirements: dict[str, JsonValue] | None = None,
        name: str | None = None, company: str | None | _Unchanged = _Unchanged.COMPANY,
    ) -> JobVersion:
        with self.store.transaction(write=True) as db:
            previous = self.store.job(db, version_id)
            now = _now()
            record = JobVersion(
                id=_id("job_version"), job_id=previous.job_id,
                version=self.store.next_job_version(db, previous.job_id),
                parent_version_id=previous.id,
                name=name if name is not None else previous.name,
                company=previous.company if isinstance(company, _Unchanged) else company,
                text=text, requirements=requirements if requirements is not None else {},
                created_at=now, updated_at=now,
            )
            self.store.add_job(db, record)
            return record

    def confirm_job(self, version_id: str) -> JobVersion:
        with self.store.transaction(write=True) as db:
            current = self.store.job(db, version_id)
            if current.status == "confirmed":
                return current
            now = _now()
            record = _replace(current, status="confirmed", confirmed_at=now, updated_at=now)
            self.store.update_job(db, record)
            return record

    def create_thread(
        self, *, session_key: str, resume_version_id: str, job_version_id: str,
        conditions: PersonalConditions | None = None,
    ) -> CareerThread:
        with self.store.transaction(write=True) as db:
            resume = self.store.resume(db, resume_version_id)
            job = self.store.job(db, job_version_id)
            if resume.status != "confirmed" or job.status != "confirmed":
                raise CareerConflictError("preparation requires a confirmed resume and job version")
            requested_conditions = conditions if conditions is not None else PersonalConditions()
            original_key = session_key
            existing = self.store.thread_for_session(db, session_key)
            while existing is not None:
                if (existing.resume_version_id, existing.job_version_id, existing.conditions) != (
                    resume.id, job.id, requested_conditions,
                ):
                    raise CareerConflictError("this session is already bound; use a new preparation chat")
                if existing.deleted_at is None:
                    return existing
                # A deleted preparation stays retired. Re-entering the same
                # materials gets a fresh chat, with concurrent entry serialized.
                session_key = f"{original_key}-{existing.id}"
                existing = self.store.thread_for_session(db, session_key)
            record = CareerThread(
                id=_id("thread"), workspace_id=self.store.workspace_id, session_key=session_key,
                resume_version_id=resume.id, job_version_id=job.id,
                conditions=requested_conditions,
                created_at=_now(),
            )
            self.store.add_thread(db, record)
            return record

    def get_thread(self, thread_id: str, *, include_deleted: bool = False) -> CareerThread:
        with self.store.transaction() as db:
            return self.store.thread(db, thread_id, include_deleted=include_deleted)

    def list_threads(self, *, include_deleted: bool = False) -> list[CareerThread]:
        with self.store.transaction() as db:
            return self.store.threads(db, include_deleted=include_deleted)

    def retire_threads(self, thread_ids: Sequence[str]) -> None:
        """Hide removed preparations while preserving their materials and history."""
        with self.store.transaction(write=True) as db:
            now = _now()
            for thread_id in thread_ids:
                thread = self.store.thread(db, thread_id, include_deleted=True)
                if thread.deleted_at is not None:
                    continue
                self.store.retire_thread(db, _replace(thread, deleted_at=now))
                for analysis in self.store.analyses(db, thread.id):
                    if analysis.status in {"queued", "running"}:
                        self.store.update_analysis(db, _replace(analysis, status="cancelled", updated_at=now))
                    self.store.cancel_draft_plans(db, analysis.id)

    def create_analysis(self, thread_id: str, *, turn_id: str | None = None) -> AnalysisRun:
        with self.store.transaction(write=True) as db:
            thread = self.store.thread(db, thread_id)
            if turn_id is not None:
                existing = self.store.analysis_for_turn(db, thread_id, turn_id)
                if existing is not None:
                    return existing
            now = _now()
            record = AnalysisRun(
                id=_id("analysis"), career_thread_id=thread.id,
                snapshot=AnalysisSnapshot(
                    resume=self.store.resume(db, thread.resume_version_id),
                    job=self.store.job(db, thread.job_version_id), conditions=thread.conditions,
                    turn_id=turn_id,
                ),
                created_at=now, updated_at=now,
            )
            self.store.add_analysis(db, record)
            return record

    def get_analysis(self, analysis_id: str) -> AnalysisRun:
        with self.store.transaction() as db:
            return self.store.analysis(db, analysis_id)

    def cancel_pending_analyses(self, thread_id: str, *, before: datetime) -> None:
        with self.store.transaction(write=True) as db:
            self.store.thread(db, thread_id)
            for current in self.store.analyses(db, thread_id):
                if current.created_at <= before and current.status in {"queued", "running"}:
                    self.store.update_analysis(db, _replace(current, status="cancelled", updated_at=_now()))
                    self.store.cancel_draft_plans(db, current.id)

    def list_analyses(self, thread_id: str) -> list[AnalysisRun]:
        with self.store.transaction() as db:
            self.store.thread(db, thread_id)
            return self.store.analyses(db, thread_id)

    def update_analysis(
        self, analysis_id: str, *, status: AnalysisStatus, result: str | None = None,
        source_reply_id: str | None = None, usage: dict[str, int] | None = None,
    ) -> AnalysisRun:
        with self.store.transaction(write=True) as db:
            current = self.store.analysis(db, analysis_id)
            if status == current.status:
                if ((result is not None and result != current.result)
                        or (source_reply_id is not None and source_reply_id != current.source_reply_id)
                        or (usage is not None and usage != current.usage)):
                    raise CareerConflictError("an analysis result cannot be rewritten in place")
                return current
            record = _replace(
                current, status=status, result=result, source_reply_id=source_reply_id,
                usage=usage if usage is not None else {}, updated_at=_now(),
            )
            if record.status not in _ANALYSIS_TRANSITIONS[current.status]:
                raise CareerConflictError(f"cannot change analysis from {current.status} to {record.status}")
            if record.status == "succeeded" and not (record.result and record.result.strip()):
                raise ValueError("successful analysis requires a nonblank result")
            self.store.update_analysis(db, record)
            if record.status in {"failed", "cancelled"}:
                self.store.cancel_draft_plans(db, record.id)
            return record

    def propose_plan(self, analysis_id: str, tasks: Sequence[TaskInput]) -> PreparationPlan:
        proposed = _TASK_LIST.validate_python(tuple(tasks))
        with self.store.transaction(write=True) as db:
            analysis = self.store.analysis(db, analysis_id)
            self.store.thread(db, analysis.career_thread_id)
            if analysis.status not in {"running", "succeeded"}:
                raise CareerConflictError("a plan draft requires a running or successful bound analysis")
            for existing in self.store.plans(db, analysis.career_thread_id):
                if existing.analysis_id == analysis.id and existing.status == "draft" and existing.proposed_tasks == proposed:
                    return existing
            record = PreparationPlan(
                id=_id("plan"), analysis_id=analysis.id, proposed_tasks=proposed, created_at=_now(),
            )
            self.store.add_plan(db, record)
            return record

    def get_plan(self, plan_id: str) -> PreparationPlan:
        with self.store.transaction() as db:
            return self.store.plan(db, plan_id)

    def list_plans(self, thread_id: str) -> list[PreparationPlan]:
        with self.store.transaction() as db:
            self.store.thread(db, thread_id)
            return self.store.plans(db, thread_id)

    def confirm_plan(
        self, plan_id: str, *, tasks: Sequence[TaskInput] | None = None,
    ) -> PreparationPlan:
        """Atomically save the user-edited selection once; a changed retry conflicts."""
        selection = _TASK_LIST.validate_python(tuple(tasks)) if tasks is not None else None
        with self.store.transaction(write=True) as db:
            current = self.store.plan(db, plan_id)
            analysis = self.store.analysis(db, current.analysis_id)
            self.store.thread(db, analysis.career_thread_id)
            if current.status == "confirmed":
                if selection is not None:
                    saved = tuple(TaskInput(
                        title=task.title, action=task.action, completion_criteria=task.completion_criteria,
                        basis=task.basis,
                    ) for task in self.store.tasks(db, plan_id))
                    if selection != saved:
                        raise CareerConflictError("this plan is already confirmed with a different selection")
                return current
            if current.status == "cancelled":
                raise CareerConflictError("a cancelled plan cannot be confirmed")
            if analysis.status != "succeeded":
                raise CareerConflictError("wait for a successful analysis before confirming its plan")
            now = _now()
            for position, task in enumerate(selection if selection is not None else current.proposed_tasks):
                self.store.add_task(db, PreparationTask(
                    id=_id("task"), plan_id=current.id, position=position,
                    title=task.title, action=task.action, completion_criteria=task.completion_criteria,
                    basis=task.basis,
                    created_at=now, updated_at=now,
                ))
            record = _replace(current, status="confirmed", confirmed_at=now)
            self.store.update_plan(db, record)
            return record

    def cancel_plan(self, plan_id: str) -> PreparationPlan:
        with self.store.transaction(write=True) as db:
            current = self.store.plan(db, plan_id)
            if current.status == "confirmed":
                raise CareerConflictError("a confirmed plan and its history must be retained")
            if current.status == "cancelled":
                return current
            record = _replace(current, status="cancelled")
            self.store.update_plan(db, record)
            return record

    def list_tasks(self, plan_id: str) -> list[PreparationTask]:
        with self.store.transaction() as db:
            self.store.plan(db, plan_id)
            return self.store.tasks(db, plan_id)

    def update_task(
        self, task_id: str, *, status: TaskStatus, result: str | None = None,
    ) -> PreparationTask:
        with self.store.transaction(write=True) as db:
            current = self.store.task(db, task_id)
            plan = self.store.plan(db, current.plan_id)
            analysis = self.store.analysis(db, plan.analysis_id)
            self.store.thread(db, analysis.career_thread_id)
            record = _replace(
                current, status=status, result=result if result is not None else current.result,
                updated_at=_now(),
            )
            self.store.update_task(db, record)
            return record
