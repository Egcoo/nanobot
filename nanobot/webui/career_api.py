"""Authenticated transport adapter for career records, without model execution."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Annotated, cast

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from nanobot.career.models import (
    CareerConflictError,
    CareerNotFoundError,
    CareerThread,
    PersonalConditions,
    ShortText,
)
from nanobot.career.service import CareerService
from nanobot.career.store import CareerStore
from nanobot.security.workspace_access import (
    WORKSPACE_SCOPE_METADATA_KEY,
    WorkspaceScope,
    build_workspace_scope,
)
from nanobot.session.manager import SessionManager
from nanobot.webui.workspaces import WebUIWorkspaceController, read_webui_workspace_state

CAREER_MUTATIONS = frozenset({
    "career.resume.create", "career.resume.edit", "career.resume.revise",
    "career.resume.rename", "career.resume.confirm",
    "career.job.create", "career.job.edit", "career.job.revise", "career.job.confirm",
    "career.thread.create",
})


class _Request(BaseModel):
    model_config = ConfigDict(extra="forbid")
    workspace_ref: ShortText


class _VersionRequest(_Request):
    id: ShortText


class _ResumeWrite(_Request):
    id: ShortText | None = None
    name: ShortText
    notes: Annotated[str, Field(max_length=5_000)] = ""
    text: Annotated[str, Field(min_length=1, max_length=200_000)]
    profile: dict[str, JsonValue] = Field(default_factory=dict)


class _ResumeRename(_VersionRequest):
    name: ShortText
    notes: Annotated[str, Field(max_length=5_000)] = ""


class _JobWrite(_Request):
    id: ShortText | None = None
    name: ShortText
    company: ShortText | None = None
    text: Annotated[str, Field(min_length=1, max_length=200_000)]
    requirements: dict[str, JsonValue] = Field(default_factory=dict)


class _ThreadCreate(_Request):
    resume_version_id: ShortText
    job_version_id: ShortText
    conditions: PersonalConditions = Field(default_factory=PersonalConditions)


def _scope_ref(scope: WorkspaceScope) -> str:
    canonical = os.path.normcase(str(scope.project_path.resolve()))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:32]


def _matches_session(metadata: dict[str, object], thread_id: str, scope: WorkspaceScope) -> bool:
    raw_scope = metadata.get(WORKSPACE_SCOPE_METADATA_KEY)
    if not isinstance(raw_scope, dict):
        return False
    fields = cast(dict[object, object], raw_scope)
    return metadata.get("career_thread_id") == thread_id and fields.get("project_path") == str(scope.project_path)


class CareerAPI:
    """Resolve opaque references from server-owned project selections on every request.

    Construction is lazy: protected gateway startup must not create a career database.
    Callers authenticate and enter runtime admission before invoking this adapter.
    """

    def __init__(
        self, *, sessions: SessionManager | None, workspaces: WebUIWorkspaceController,
        data_dir: Path,
    ) -> None:
        self.sessions = sessions
        self.workspaces = workspaces
        self.data_dir = data_dir
        self._lifecycle_lock = asyncio.Lock()

    def _scopes(self) -> dict[str, WorkspaceScope]:
        default = self.workspaces.default_scope()
        scopes = {_scope_ref(default): default}
        state = read_webui_workspace_state()
        for path in (*state["favorite_projects"], *state["recent_projects"]):
            project = Path(path)
            if project.is_dir():
                scope = build_workspace_scope(project, default.access_mode, source_channel="websocket")
                scopes.setdefault(_scope_ref(scope), scope)
        if self.sessions is not None:
            for row in self.sessions.list_session_metadata():
                if not str(row["key"]).startswith("websocket:"):
                    continue
                metadata = row["metadata"]
                scope = self.workspaces.scope_for_indexed_metadata(
                    metadata.get(WORKSPACE_SCOPE_METADATA_KEY),
                    scope_present=WORKSPACE_SCOPE_METADATA_KEY in metadata, default_scope=default,
                )
                scopes.setdefault(_scope_ref(scope), scope)
        return scopes

    def _resolve(self, reference: str) -> tuple[CareerService, WorkspaceScope]:
        if self.sessions is None:
            raise CareerConflictError("career_unavailable")

        scope = self._scopes().get(reference)
        if scope is None:
            raise CareerNotFoundError("career_workspace_not_found")
        return CareerService(CareerStore(scope.project_path, data_dir=self.data_dir)), scope

    def catalog(self) -> dict[str, object]:
        default_ref = _scope_ref(self.workspaces.default_scope())
        return {"workspaces": [
            {"ref": ref, "name": scope.project_name, "is_default": ref == default_ref}
            for ref, scope in self._scopes().items()
        ]}

    def session_binding(
        self, chat_id: str, scope: WorkspaceScope,
    ) -> tuple[CareerService, CareerThread, str] | None:
        if self.sessions is None:
            return None
        session_key = f"websocket:{chat_id}"
        stored = self.sessions.read_session_metadata(session_key)
        metadata: dict[str, object] = stored["metadata"] if stored is not None else {}
        if "career_thread_id" not in metadata:
            if chat_id.startswith("career-"):
                raise CareerConflictError("career_session_conflict")
            return None
        thread_id = metadata["career_thread_id"]
        if not isinstance(thread_id, str) or not thread_id:
            raise CareerConflictError("career_session_conflict")
        reference = _scope_ref(scope)
        service, _ = self._resolve(reference)
        thread = service.get_thread(thread_id)
        if thread.session_key != session_key or not _matches_session(metadata, thread.id, scope):
            raise CareerConflictError("career_session_conflict")
        return service, thread, reference

    def bound_thread(self, reference: str, thread_id: str) -> tuple[CareerService, CareerThread]:
        service, scope = self._resolve(reference)
        thread = service.get_thread(thread_id)
        chat_id = thread.session_key.removeprefix("websocket:")
        binding = self.session_binding(chat_id, scope)
        if binding is None or binding[1].id != thread.id:
            raise CareerConflictError("career_session_conflict")
        return service, thread

    def _retire_missing_threads(self, service: CareerService) -> None:
        assert self.sessions is not None
        # Read every session before writing. A storage error or a mismatched
        # binding is not evidence of deletion. Serialize this with chat creation.
        missing = [thread.id for thread in service.list_threads()
                   if thread.session_key.startswith("websocket:career-")
                   and self.sessions.read_session_metadata(thread.session_key) is None]
        if missing:
            service.retire_threads(missing)

    async def state(self, reference: str) -> dict[str, object]:
        async with self._lifecycle_lock:
            return await asyncio.to_thread(self._state, reference)

    def _state(self, reference: str) -> dict[str, object]:
        service, scope = self._resolve(reference)
        self._retire_missing_threads(service)
        threads = service.list_threads()
        plans = [(plan, thread.id) for thread in threads for plan in service.list_plans(thread.id)
                 if plan.status == "confirmed"]
        tasks = [task for plan, _ in plans for task in service.list_tasks(plan.id)]
        availability: dict[str, bool] = {}
        for thread in threads:
            payload = self.sessions.read_session_metadata(thread.session_key) if self.sessions else None
            metadata: dict[str, object] = payload["metadata"] if payload is not None else {}
            availability[thread.id] = _matches_session(metadata, thread.id, scope)
        return {
            "workspace_ref": reference, "workspace_id": service.store.workspace_id,
            "resumes": [item.model_dump(mode="json") for item in service.list_resumes()],
            "jobs": [item.model_dump(mode="json") for item in service.list_jobs()],
            "threads": [item.model_dump(mode="json") for item in threads],
            "deleted_thread_ids": [item.id for item in service.list_threads(include_deleted=True) if item.deleted_at is not None],
            "plans": [{**item.model_dump(mode="json"), "career_thread_id": thread_id}
                      for item, thread_id in plans],
            "tasks": [item.model_dump(mode="json") for item in tasks],
            "chat_available": availability,
        }

    def _deletion_binding(self, session_key: str) -> tuple[CareerService, CareerThread] | None:
        if self.sessions is None or not session_key.startswith("websocket:career-"):
            return None
        stored = self.sessions.read_session_metadata(session_key)
        if stored is None:
            return None
        metadata = stored["metadata"]
        thread_id = metadata.get("career_thread_id")
        if not isinstance(thread_id, str):
            return None
        scope = self.workspaces.scope_for_session_key(session_key)
        service, _ = self._resolve(_scope_ref(scope))
        try:
            thread = service.get_thread(thread_id)
        except CareerNotFoundError:
            return None
        if thread.session_key == session_key and _matches_session(metadata, thread.id, scope):
            return service, thread
        return None

    async def delete_session(self, session_key: str, delete: Callable[[], Awaitable[bool]]) -> bool:
        async with self._lifecycle_lock:
            binding = await asyncio.to_thread(self._deletion_binding, session_key)
            deleted = await delete()
            if deleted and binding is not None:
                await asyncio.to_thread(binding[0].retire_threads, [binding[1].id])
            return deleted

    def _mutate_record(self, action: str, payload: dict[str, object]) -> dict[str, object]:
        if action in {"career.resume.confirm", "career.job.confirm"}:
            request = _VersionRequest.model_validate(payload)
            service, _ = self._resolve(request.workspace_ref)
            record = (service.confirm_resume(request.id) if action == "career.resume.confirm"
                      else service.confirm_job(request.id))
            return record.model_dump(mode="json")
        if action == "career.resume.rename":
            rename = _ResumeRename.model_validate(payload)
            service, _ = self._resolve(rename.workspace_ref)
            return service.rename_resume(rename.id, name=rename.name, notes=rename.notes).model_dump(mode="json")
        if action.startswith("career.resume."):
            resume = _ResumeWrite.model_validate(payload)
            service, _ = self._resolve(resume.workspace_ref)
            if action == "career.resume.create":
                if resume.id is not None:
                    raise ValueError("career_invalid_request")
                return service.create_resume(
                    name=resume.name, text=resume.text, notes=resume.notes, profile=resume.profile,
                ).model_dump(mode="json")
            if resume.id is None:
                raise ValueError("career_invalid_request")
            if action == "career.resume.revise":
                return service.revise_resume(
                    resume.id, name=resume.name, notes=resume.notes, text=resume.text, profile=resume.profile,
                ).model_dump(mode="json")
            return service.edit_resume_draft(
                resume.id, name=resume.name, notes=resume.notes, text=resume.text, profile=resume.profile,
            ).model_dump(mode="json")
        job = _JobWrite.model_validate(payload)
        service, _ = self._resolve(job.workspace_ref)
        if action == "career.job.create":
            if job.id is not None:
                raise ValueError("career_invalid_request")
            return service.create_job(
                name=job.name, company=job.company, text=job.text, requirements=job.requirements,
            ).model_dump(mode="json")
        if job.id is None:
            raise ValueError("career_invalid_request")
        if action == "career.job.revise":
            return service.revise_job(
                job.id, name=job.name, company=job.company, text=job.text, requirements=job.requirements,
            ).model_dump(mode="json")
        return service.edit_job_draft(
            job.id, name=job.name, company=job.company, text=job.text, requirements=job.requirements,
        ).model_dump(mode="json")

    async def mutate(self, action: str, payload: dict[str, object]) -> dict[str, object]:
        if action not in CAREER_MUTATIONS:
            raise CareerNotFoundError("career_action_not_found")
        if action != "career.thread.create":
            return await asyncio.to_thread(self._mutate_record, action, payload)
        async with self._lifecycle_lock:
            return await self._create_thread(payload)

    async def _create_thread(self, payload: dict[str, object]) -> dict[str, object]:
        request = _ThreadCreate.model_validate(payload)
        service, scope = await asyncio.to_thread(self._resolve, request.workspace_ref)
        await asyncio.to_thread(self._retire_missing_threads, service)
        binding = json.dumps({
            "workspace_id": service.store.workspace_id,
            "resume": request.resume_version_id, "job": request.job_version_id,
            "conditions": request.conditions.model_dump(mode="json"),
        }, sort_keys=True, ensure_ascii=False)
        chat_id = "career-" + hashlib.sha256(binding.encode("utf-8")).hexdigest()[:32]
        thread = await asyncio.to_thread(
            service.create_thread, session_key=f"websocket:{chat_id}",
            resume_version_id=request.resume_version_id, job_version_id=request.job_version_id,
            conditions=request.conditions,
        )
        if self.sessions is None:
            raise CareerConflictError("career_unavailable")

        title = await asyncio.to_thread(lambda: (
            f"{service.get_resume(thread.resume_version_id).name} → "
            f"{service.get_job(thread.job_version_id).name}"
        )[:160])

        def bind(metadata: dict[str, object]) -> None:
            if metadata:
                if not _matches_session(metadata, thread.id, scope):
                    raise CareerConflictError("career_session_conflict")
                return  # Preserve the existing chat's access policy and other metadata.
            metadata.update({
                "webui": True, "career_thread_id": thread.id,
                "title": title,
                WORKSPACE_SCOPE_METADATA_KEY: scope.metadata(),
            })

        await self.sessions.state.mutate_metadata(thread.session_key, bind, create_if_missing=True)
        return thread.model_dump(mode="json")
