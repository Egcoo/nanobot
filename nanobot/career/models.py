"""Validated career records; confirmation is user acknowledgement, not verification."""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, StringConstraints, field_validator

ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
BodyText = Annotated[str, Field(min_length=1, max_length=200_000)]


class CareerNotFoundError(LookupError):
    """The requested record does not exist in the selected workspace."""


class CareerConflictError(ValueError):
    """An operation conflicts with a confirmed record or its lifecycle."""


class _CareerModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, allow_inf_nan=False)


class PersonalConditions(_CareerModel):
    days_per_week: Annotated[int, Field(strict=True, ge=1, le=7)] | None = None
    available_months: Annotated[int, Field(strict=True, ge=1)] | None = None
    available_from: date | None = None
    locations: tuple[ShortText, ...] = ()


class ResumeVersion(_CareerModel):
    id: str
    version: Annotated[int, Field(ge=1)]
    parent_version_id: str | None = None
    name: ShortText
    notes: Annotated[str, Field(max_length=5_000)] = ""
    source: Literal["text"] = "text"
    text: BodyText
    profile: dict[str, JsonValue] = Field(default_factory=dict)
    status: Literal["draft", "confirmed"] = "draft"
    created_at: datetime
    updated_at: datetime
    confirmed_at: datetime | None = None

    @field_validator("text")
    @classmethod
    def nonblank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("resume text must not be blank")
        return value


class JobVersion(_CareerModel):
    id: str
    job_id: str
    version: Annotated[int, Field(ge=1)]
    parent_version_id: str | None = None
    name: ShortText
    company: ShortText | None = None
    source: Literal["text"] = "text"
    text: BodyText
    requirements: dict[str, JsonValue] = Field(default_factory=dict)
    status: Literal["draft", "confirmed"] = "draft"
    created_at: datetime
    updated_at: datetime
    confirmed_at: datetime | None = None

    @field_validator("text")
    @classmethod
    def nonblank_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("job text must not be blank")
        return value


class CareerThread(_CareerModel):
    id: str
    workspace_id: str
    session_key: ShortText
    resume_version_id: str
    job_version_id: str
    conditions: PersonalConditions
    created_at: datetime
    deleted_at: datetime | None = None


class AnalysisSnapshot(_CareerModel):
    resume: ResumeVersion
    job: JobVersion
    conditions: PersonalConditions
    turn_id: ShortText | None = None


AnalysisStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]


class AnalysisRun(_CareerModel):
    id: str
    career_thread_id: str
    snapshot: AnalysisSnapshot
    status: AnalysisStatus = "queued"
    source_reply_id: ShortText | None = None
    result: Annotated[str, Field(max_length=200_000)] | None = None
    usage: dict[str, Annotated[int, Field(strict=True, ge=0)]] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class TaskInput(_CareerModel):
    title: ShortText
    action: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=5_000)]
    completion_criteria: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=5_000)
    ]


TaskList = Annotated[tuple[TaskInput, ...], Field(min_length=1, max_length=50)]


class PreparationPlan(_CareerModel):
    id: str
    analysis_id: str
    proposed_tasks: TaskList
    status: Literal["draft", "confirmed", "cancelled"] = "draft"
    created_at: datetime
    confirmed_at: datetime | None = None


TaskStatus = Literal["pending", "completed"]


class PreparationTask(_CareerModel):
    id: str
    plan_id: str
    position: Annotated[int, Field(ge=0)]
    title: ShortText
    action: str
    completion_criteria: str
    status: TaskStatus = "pending"
    result: Annotated[str, Field(max_length=20_000)] = ""
    created_at: datetime
    updated_at: datetime
