from __future__ import annotations

import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from pydantic import ValidationError

from nanobot.career.models import (
    CareerConflictError,
    CareerNotFoundError,
    CareerThread,
    PersonalConditions,
    PreparationTask,
    TaskInput,
)
from nanobot.career.service import CareerService
from nanobot.career.store import CareerStore


def _successful_analysis(service: CareerService, thread: CareerThread) -> str:
    analysis = service.create_analysis(thread.id)
    service.update_analysis(analysis.id, status="running")
    service.update_analysis(
        analysis.id, status="succeeded", result="工程测试结果，不代表真实模型输出。",
        source_reply_id="test-reply-1", usage={"input_tokens": 12, "output_tokens": 8},
    )
    return analysis.id


def test_same_name_resumes_have_independent_identity_and_editable_drafts(
    service: CareerService,
) -> None:
    first = service.create_resume(name="简历.txt", text="  原始正文\n", notes="通用版")
    second = service.create_resume(name="简历.txt", text="第二份正文", notes="产品版")
    assert first.id != second.id
    assert [item.version for item in service.list_resumes()] == [1, 2]
    assert service.get_resume(first.id).text == "  原始正文\n"
    edited = service.edit_resume_draft(second.id, text="修改后的正文", profile={"project": "原型"})
    assert edited.id == second.id
    assert edited.profile == {"project": "原型"}
    assert edited.notes == "产品版"
    assert service.get_resume(first.id) == first


def test_confirmed_resume_content_requires_a_new_draft_version(service: CareerService) -> None:
    original = service.create_resume(name="简历", text="原文", profile={"experience": "旧资料"})
    confirmed = service.confirm_resume(original.id)
    assert service.confirm_resume(original.id) == confirmed
    with pytest.raises(CareerConflictError, match="new version"):
        service.edit_resume_draft(original.id, text="不允许原地覆盖")
    revised = service.revise_resume(original.id, text="新增了项目", name="求职版")
    assert revised.parent_version_id == original.id
    assert revised.version == 2
    assert revised.id != original.id
    assert revised.status == "draft"
    assert revised.confirmed_at is None
    assert revised.profile == {}  # Old extracted facts must not silently follow edited text.
    assert service.get_resume(original.id) == confirmed
    renamed = service.rename_resume(original.id, name="归档名称", notes="备注可改")
    assert renamed.text == confirmed.text
    assert renamed.profile == confirmed.profile
    assert renamed.status == "confirmed"


def test_jobs_preserve_unknown_fields_and_version_old_requirements(service: CareerService) -> None:
    first = service.create_job(name="产品实习", text="每周三天")
    second = service.create_job(name="产品实习", text="其他岗位")
    assert first.job_id != second.job_id
    assert first.company is None
    assert first.requirements == {}
    edited = service.edit_job_draft(
        first.id, name=first.name, company="测试公司", text="每周三天",
        requirements={"days_per_week": 3, "location": None},
    )
    confirmed = service.confirm_job(first.id)
    assert confirmed.requirements == edited.requirements
    assert service.confirm_job(first.id) == confirmed
    with pytest.raises(CareerConflictError):
        service.edit_job_draft(first.id, name=first.name, company=None, text="每周四天")
    revised = service.revise_job(first.id, text="每周四天", requirements={"days_per_week": 4})
    assert revised.job_id == first.job_id
    assert revised.version == 2
    assert revised.parent_version_id == first.id
    assert revised.status == "draft"
    assert service.get_job(first.id) == confirmed


@pytest.mark.parametrize("kind", ["resume", "job"])
def test_blank_text_is_rejected_without_creating_records(service: CareerService, kind: str) -> None:
    create = service.create_resume if kind == "resume" else service.create_job
    with pytest.raises(ValidationError):
        create(name="资料", text=" \n ")
    assert service.list_resumes() == []
    assert service.list_jobs() == []


@pytest.mark.parametrize("unconfirmed", ["resume", "job"])
def test_preparation_requires_both_versions_to_be_confirmed(
    service: CareerService, unconfirmed: str,
) -> None:
    resume = service.create_resume(name="简历", text="正文")
    job = service.create_job(name="岗位", text="正文")
    if unconfirmed != "resume":
        service.confirm_resume(resume.id)
    if unconfirmed != "job":
        service.confirm_job(job.id)
    with pytest.raises(CareerConflictError, match="confirmed"):
        service.create_thread(session_key="test", resume_version_id=resume.id, job_version_id=job.id)
    assert service.list_threads() == []


def test_session_binding_is_idempotent_and_cannot_be_retargeted(
    service: CareerService, thread: CareerThread,
) -> None:
    duplicate = service.create_thread(
        session_key=thread.session_key, resume_version_id=thread.resume_version_id,
        job_version_id=thread.job_version_id, conditions=thread.conditions,
    )
    assert duplicate == thread
    new_resume = service.revise_resume(thread.resume_version_id, text="另一版简历")
    service.confirm_resume(new_resume.id)
    service.get_resume(new_resume.id)  # Viewing a version must not change an existing binding.
    with pytest.raises(CareerConflictError, match="already bound"):
        service.create_thread(
            session_key=thread.session_key, resume_version_id=new_resume.id,
            job_version_id=thread.job_version_id, conditions=thread.conditions,
        )
    with pytest.raises(CareerConflictError, match="already bound"):
        service.create_thread(
            session_key=thread.session_key, resume_version_id=thread.resume_version_id,
            job_version_id=thread.job_version_id, conditions=PersonalConditions(days_per_week=5),
        )
    another = service.create_thread(
        session_key="another-session", resume_version_id=new_resume.id,
        job_version_id=thread.job_version_id,
    )
    assert another.id != thread.id
    assert service.get_thread(thread.id) == thread
    assert service.list_threads() == [thread, another]


def test_queued_snapshot_survives_renaming_revision_and_retry(
    service: CareerService, thread: CareerThread,
) -> None:
    analysis = service.create_analysis(thread.id)
    original_snapshot = analysis.snapshot
    renamed = service.rename_resume(thread.resume_version_id, name="后来改的名称", notes="新备注")
    new_resume = service.revise_resume(renamed.id, text="后来改的正文")
    new_job = service.revise_job(thread.job_version_id, text="后来改的岗位要求")
    service.confirm_resume(new_resume.id)
    service.confirm_job(new_job.id)
    service.create_thread(
        session_key="another-target", resume_version_id=new_resume.id, job_version_id=new_job.id,
        conditions=PersonalConditions(days_per_week=5),
    )
    service.update_analysis(analysis.id, status="running")
    service.update_analysis(analysis.id, status="failed", result="工程模拟失败")
    service.update_analysis(analysis.id, status="queued")
    service.update_analysis(analysis.id, status="running")
    final = service.update_analysis(
        analysis.id, status="succeeded", result="工程模拟恢复", source_reply_id="original-chat-reply",
    )
    assert final.snapshot == original_snapshot
    assert final.snapshot.resume.name != renamed.name
    assert final.snapshot.resume.id == thread.resume_version_id
    assert final.snapshot.job.id == thread.job_version_id
    assert final.snapshot.conditions.days_per_week == 3
    assert final.snapshot.resume.profile["interview_experience"] is None
    assert final.career_thread_id == thread.id
    later = service.create_analysis(thread.id)
    assert later.snapshot.resume.name == renamed.name
    assert service.list_analyses(thread.id) == [final, later]
    assert service.update_analysis(analysis.id, status="succeeded") == final
    with pytest.raises(CareerConflictError):
        service.update_analysis(analysis.id, status="succeeded", result="覆盖历史结果")


def test_proposal_is_not_a_formal_task_and_needs_success_before_confirmation(
    service: CareerService, thread: CareerThread, proposals: tuple[TaskInput, ...],
) -> None:
    with pytest.raises(CareerNotFoundError):
        service.propose_plan("unbound-analysis", proposals)
    analysis = service.create_analysis(thread.id)
    with pytest.raises(CareerConflictError):
        service.propose_plan(analysis.id, proposals)
    service.update_analysis(analysis.id, status="running")
    draft = service.propose_plan(analysis.id, proposals)
    assert draft.status == "draft"
    assert service.list_tasks(draft.id) == []
    with pytest.raises(CareerConflictError, match="successful"):
        service.confirm_plan(draft.id)
    service.update_analysis(analysis.id, status="succeeded", result="工程测试结果")
    assert service.confirm_plan(draft.id).status == "confirmed"
    assert len(service.list_tasks(draft.id)) == 3


def test_edited_selection_is_saved_once_and_retries_preserve_progress(
    service: CareerService, thread: CareerThread, proposals: tuple[TaskInput, ...],
) -> None:
    analysis_id = _successful_analysis(service, thread)
    draft = service.propose_plan(analysis_id, proposals)
    edited = TaskInput(title="我修改的任务", action="只整理一页项目说明。", completion_criteria="一页即可。")
    selection = (edited, proposals[2])
    confirmed = service.confirm_plan(draft.id, tasks=selection)
    tasks = service.list_tasks(draft.id)
    assert [item.title for item in tasks] == [edited.title, proposals[2].title]
    assert tasks[0].action == edited.action
    assert tasks[0].completion_criteria == edited.completion_criteria
    assert service.get_plan(draft.id).proposed_tasks == proposals
    completed = service.update_task(tasks[0].id, status="completed", result="已完成一页")
    assert service.confirm_plan(draft.id, tasks=selection) == confirmed
    assert service.confirm_plan(draft.id) == confirmed
    assert service.list_tasks(draft.id) == [completed, tasks[1]]
    with pytest.raises(CareerConflictError, match="different selection"):
        service.confirm_plan(draft.id, tasks=proposals)
    assert service.list_plans(thread.id) == [confirmed]
    reopened = service.update_task(tasks[0].id, status="pending")
    assert reopened.result == "已完成一页"
    assert service.list_tasks(draft.id) == [reopened, tasks[1]]


def test_cancelling_draft_keeps_existing_plan_and_tasks(
    service: CareerService, thread: CareerThread, proposals: tuple[TaskInput, ...],
) -> None:
    analysis_id = _successful_analysis(service, thread)
    existing = service.propose_plan(analysis_id, proposals)
    service.confirm_plan(existing.id)
    original_tasks = service.list_tasks(existing.id)
    draft = service.propose_plan(analysis_id, proposals)
    cancelled = service.cancel_plan(draft.id)
    assert service.cancel_plan(draft.id) == cancelled
    assert service.list_tasks(draft.id) == []
    with pytest.raises(CareerConflictError):
        service.confirm_plan(draft.id)
    with pytest.raises(CareerConflictError):
        service.cancel_plan(existing.id)
    assert service.list_tasks(existing.id) == original_tasks


@pytest.mark.parametrize("status", ["failed", "cancelled"])
def test_unsuccessful_run_cancels_its_drafts(
    service: CareerService, thread: CareerThread, proposals: tuple[TaskInput, ...], status: str,
) -> None:
    analysis = service.create_analysis(thread.id)
    service.update_analysis(analysis.id, status="running")
    draft = service.propose_plan(analysis.id, proposals)
    service.update_analysis(analysis.id, status=status, result="工程测试中止")
    assert service.get_plan(draft.id).status == "cancelled"
    assert service.list_tasks(draft.id) == []
    if status == "failed":
        service.update_analysis(analysis.id, status="queued")
        service.update_analysis(analysis.id, status="running")
        service.update_analysis(analysis.id, status="succeeded", result="工程测试恢复")
    with pytest.raises(CareerConflictError):
        service.confirm_plan(draft.id)


def test_failed_confirmation_rolls_back_all_tasks_and_can_be_retried(
    service: CareerService, thread: CareerThread, proposals: tuple[TaskInput, ...],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    draft = service.propose_plan(_successful_analysis(service, thread), proposals)
    original_add = CareerStore.add_task

    def fail_second_insert(db: sqlite3.Connection, task: PreparationTask) -> None:
        if task.position == 1:
            raise sqlite3.OperationalError("simulated storage failure")
        original_add(db, task)

    with monkeypatch.context() as patch:
        patch.setattr(CareerStore, "add_task", staticmethod(fail_second_insert))
        with pytest.raises(sqlite3.OperationalError):
            service.confirm_plan(draft.id)
    assert service.get_plan(draft.id).status == "draft"
    assert service.list_tasks(draft.id) == []
    service.confirm_plan(draft.id)
    assert len(service.list_tasks(draft.id)) == 3


def test_simultaneous_confirmations_across_stores_save_one_plan(
    service: CareerService, thread: CareerThread, proposals: tuple[TaskInput, ...], tmp_path: Path,
) -> None:
    draft = service.propose_plan(_successful_analysis(service, thread), proposals)
    other = CareerService(CareerStore(tmp_path / "workspace", data_dir=tmp_path / "data"))
    barrier = threading.Barrier(2)

    def confirm(instance: CareerService) -> str:
        barrier.wait(timeout=5)
        return instance.confirm_plan(draft.id).id

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(confirm, (service, other)))
    assert results == [draft.id, draft.id]
    assert len(service.list_tasks(draft.id)) == 3
    assert service.list_tasks(draft.id) == other.list_tasks(draft.id)


def test_simultaneous_resume_creation_allocates_unique_display_versions(service: CareerService) -> None:
    barrier = threading.Barrier(3)

    def create(index: int) -> int:
        barrier.wait(timeout=5)
        return service.create_resume(name="同名简历", text=f"工程测试 {index}").version

    with ThreadPoolExecutor(max_workers=3) as pool:
        versions = list(pool.map(create, range(3)))
    assert sorted(versions) == [1, 2, 3]
    assert len({record.id for record in service.list_resumes()}) == 3


def test_reopening_database_restores_all_record_types_and_old_target_progress(
    service: CareerService, thread: CareerThread, proposals: tuple[TaskInput, ...], tmp_path: Path,
) -> None:
    analysis_id = _successful_analysis(service, thread)
    plan = service.confirm_plan(service.propose_plan(analysis_id, proposals).id)
    tasks = service.list_tasks(plan.id)
    completed = service.update_task(tasks[0].id, status="completed", result="工程测试已完成")
    new_job = service.create_job(name="另一个岗位", text="不同要求")
    service.confirm_job(new_job.id)
    service.create_thread(
        session_key="career:test-session-b", resume_version_id=thread.resume_version_id,
        job_version_id=new_job.id,
    )
    restored = CareerService(CareerStore(tmp_path / "workspace", data_dir=tmp_path / "data"))
    assert restored.get_resume(thread.resume_version_id) == service.get_resume(thread.resume_version_id)
    assert restored.get_job(thread.job_version_id) == service.get_job(thread.job_version_id)
    assert restored.get_thread(thread.id) == thread
    assert restored.get_analysis(analysis_id) == service.get_analysis(analysis_id)
    assert restored.get_plan(plan.id) == plan
    assert restored.list_tasks(plan.id) == [completed, *tasks[1:]]
    assert restored.list_plans(restored.list_threads()[1].id) == []


def test_cross_workspace_references_are_rejected(
    service: CareerService, thread: CareerThread, proposals: tuple[TaskInput, ...], tmp_path: Path,
) -> None:
    analysis_id = _successful_analysis(service, thread)
    plan = service.confirm_plan(service.propose_plan(analysis_id, proposals).id)
    task = service.list_tasks(plan.id)[0]
    other = CareerService(CareerStore(tmp_path / "other-workspace", data_dir=tmp_path / "data"))
    assert other.store.workspace_id != service.store.workspace_id
    assert other.list_resumes() == []
    assert other.list_jobs() == []
    assert other.list_threads() == []
    for read, foreign_id in (
        (other.get_resume, thread.resume_version_id), (other.get_job, thread.job_version_id),
        (other.get_thread, thread.id), (other.get_analysis, analysis_id), (other.get_plan, plan.id),
    ):
        with pytest.raises(CareerNotFoundError):
            read(foreign_id)
    with pytest.raises(CareerNotFoundError):
        other.update_task(task.id, status="completed")
    with pytest.raises(CareerNotFoundError):
        other.create_thread(
            session_key=thread.session_key, resume_version_id=thread.resume_version_id,
            job_version_id=thread.job_version_id,
        )
    assert service.list_tasks(plan.id)[0] == task


def test_empty_selection_cannot_confirm_or_create_an_empty_plan(
    service: CareerService, thread: CareerThread, proposals: tuple[TaskInput, ...],
) -> None:
    analysis_id = _successful_analysis(service, thread)
    with pytest.raises(ValidationError):
        service.propose_plan(analysis_id, [])
    draft = service.propose_plan(analysis_id, proposals)
    with pytest.raises(ValidationError):
        service.confirm_plan(draft.id, tasks=[])
    assert service.get_plan(draft.id).status == "draft"
    assert service.list_tasks(draft.id) == []
