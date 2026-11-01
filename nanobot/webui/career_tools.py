"""The only model-side write exposed by the career workbench: a draft proposal."""

from __future__ import annotations

import json
import sqlite3
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from nanobot.agent.tools.base import Tool
from nanobot.agent.tools.context import current_request_context
from nanobot.bus.outbound_events import SessionUpdatedEvent, outbound_message_for_event
from nanobot.bus.queue import MessageBus
from nanobot.career.models import CareerConflictError, CareerNotFoundError, TaskInput, TaskList
from nanobot.webui.career_api import CareerAPI


class _Proposal(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tasks: Annotated[tuple[TaskInput, ...], Field(min_length=1, max_length=8)]

    @field_validator("tasks")
    @classmethod
    def require_basis(cls, value: TaskList) -> TaskList:
        if any(not item.basis for item in value):
            raise ValueError("each proposed task requires a material-based reason")
        return value


class ProposePreparationPlanTool(Tool):
    _description = (
        "Propose 1-8 preparation tasks for the resume and job already bound to the current career conversation. "
        "Each task needs a title, concrete action, completion criteria and a basis in the selected materials. "
        "Only creates an editable draft. It never confirms tasks, changes progress, edits a resume or applies for a job. "
        "Requires a bound career-workbench turn; unavailable in ordinary conversations."
    )
    _parameters: dict[str, Any] = {
        "type": "object", "additionalProperties": False, "required": ["tasks"],
        "properties": {"tasks": {
            "type": "array", "minItems": 1, "maxItems": 8,
            "items": {
                "type": "object", "additionalProperties": False,
                "required": ["title", "action", "completion_criteria", "basis"],
                "properties": {
                    "title": {"type": "string", "minLength": 1, "maxLength": 500},
                    "action": {"type": "string", "minLength": 1, "maxLength": 5_000},
                    "completion_criteria": {"type": "string", "minLength": 1, "maxLength": 5_000},
                    "basis": {"type": "string", "minLength": 1, "maxLength": 2_000},
                },
            },
        }},
    }

    def __init__(self, api: CareerAPI, bus: MessageBus) -> None:
        self.api, self.bus = api, bus

    @property
    def name(self) -> str:
        return "propose_preparation_plan"

    @property
    def description(self) -> str:
        return self._description

    @property
    def parameters(self) -> dict[str, Any]:
        return self._parameters

    async def execute(self, **kwargs: Any) -> str:
        context = current_request_context()
        if context is None:
            return self.error("A bound career-workbench turn is required. No tasks were saved.")
        try:
            proposal = _Proposal.model_validate(kwargs)
            result = await self.api.propose_plan_for_turn(context, proposal.tasks)
        except (CareerConflictError, CareerNotFoundError, ValidationError, ValueError):
            return self.error("Cannot create this draft for the current turn. Check the selected materials and task fields. No tasks were saved.")
        except (OSError, sqlite3.Error):
            return self.error("Preparation storage is unavailable. No tasks were saved; try again later.")
        await self.bus.publish_outbound(outbound_message_for_event(
            channel="websocket", chat_id=context.chat_id, event=SessionUpdatedEvent(scope="metadata"),
        ))
        return json.dumps({"draft_id": result["id"], "status": result["status"],
                           "requires_user_confirmation": True, "saved_as_tasks": False}, ensure_ascii=False)
