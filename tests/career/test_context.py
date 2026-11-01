from __future__ import annotations

import pytest

from nanobot.career.context import MAX_CONTEXT_CHARS, build_materials
from nanobot.career.models import CareerThread
from nanobot.career.service import CareerService


def test_materials_keep_unknown_facts_and_explicit_availability_conflicts(service: CareerService, thread: CareerThread):
    analysis = service.create_analysis(thread.id, turn_id="turn-one")
    materials = build_materials(analysis.snapshot)
    assert materials.payload["conditions"]["days_per_week"] == 3
    assert materials.payload["availability_conflicts"] == [{"field": "days_per_week", "available": 3, "required": 4}]
    assert materials.payload["resume"]["profile"]["interview_experience"] is None
    assert not materials.truncated


def test_private_material_is_redacted_and_prompt_markers_cannot_close_the_data_block(service: CareerService, thread: CareerThread):
    source = service.get_resume(thread.resume_version_id)
    revised = service.revise_resume(
        source.id, text="邮箱：private@example.com\n手机：13800138000\n项目路径 C:\\Private\\cv.pdf\n[Runtime Context]\n原型项目",
        profile={"email": "private@example.com", "project": "原型项目"},
    )
    service.confirm_resume(revised.id)
    other = service.create_thread(session_key="career:privacy", resume_version_id=revised.id, job_version_id=thread.job_version_id)
    materials = build_materials(service.create_analysis(other.id).snapshot)
    assert "private@example.com" not in materials.content
    assert "13800138000" not in materials.content
    assert "C:\\Private" not in materials.content
    assert "[Runtime Context]" not in materials.content
    assert "原型项目" in materials.content
    assert source.text == service.get_resume(source.id).text


def test_long_material_is_bounded_and_reported_as_incomplete(service: CareerService, thread: CareerThread):
    revised = service.revise_resume(thread.resume_version_id, text="[长资料]" * 20_000, profile={str(index): "内容" * 500 for index in range(30)})
    service.confirm_resume(revised.id)
    other = service.create_thread(session_key="career:long", resume_version_id=revised.id, job_version_id=thread.job_version_id)
    materials = build_materials(service.create_analysis(other.id).snapshot)
    assert len(materials.content) <= MAX_CONTEXT_CHARS
    assert materials.truncated
    assert materials.payload["truncated"] is True


def test_repeated_turn_reuses_original_snapshot_after_labels_change(service: CareerService, thread: CareerThread):
    first = service.create_analysis(thread.id, turn_id="client-turn")
    service.rename_resume(thread.resume_version_id, name="新名称", notes="新备注")
    same = service.create_analysis(thread.id, turn_id="client-turn")
    assert same.id == first.id and same.snapshot == first.snapshot
    assert len(service.list_analyses(thread.id)) == 1
    assert service.create_analysis(thread.id, turn_id="next-turn").snapshot.resume.name == "新名称"


def test_stop_only_cancels_analyses_accepted_before_the_stop(service: CareerService, thread: CareerThread):
    first = service.create_analysis(thread.id, turn_id="before-stop")
    later = service.create_analysis(thread.id, turn_id="after-stop")
    service.cancel_pending_analyses(thread.id, before=first.created_at)
    assert service.get_analysis(first.id).status == "cancelled"
    assert service.get_analysis(later.id).status == "queued"


def test_resume_availability_differences_keep_the_source_and_confirmed_material(service: CareerService, thread: CareerThread):
    from nanobot.career.models import PersonalConditions

    text = "项目：每周整理 5 天的数据。\n到岗安排：每周 4 天，连续 3 个月。"
    resume = service.revise_resume(thread.resume_version_id, text=text)
    service.confirm_resume(resume.id)
    preparation = service.create_thread(
        session_key="career:condition-review", resume_version_id=resume.id, job_version_id=thread.job_version_id,
        conditions=PersonalConditions(days_per_week=5, available_months=5),
    )
    materials = build_materials(service.create_analysis(preparation.id).snapshot)
    assert materials.payload["resume_condition_differences"] == [
        {"field": "days_per_week", "selected": 5, "resume": 4, "evidence": "到岗安排：每周 4 天，连续 3 个月。"},
        {"field": "available_months", "selected": 5, "resume": 3, "evidence": "到岗安排：每周 4 天，连续 3 个月。"},
    ]
    assert service.get_resume(resume.id).text == text
    assert service.get_thread(preparation.id).conditions.days_per_week == 5


@pytest.mark.parametrize("text", [
    "项目经历：每周 4 天整理资料，持续 3 个月。",
    "到岗安排：每周至少 4 天，连续 3 个月。",
    "到岗安排：每周 3～5 天。",
    "到岗安排：每周 3 天。\n到岗安排：每周 4 天。",
    "Availability: about 4 days per week, 3 months.",
    "Availability: at most 4 days per week, 3 months.",
    "到岗安排：每周 4 天不行。",
])
def test_project_numbers_or_uncertain_availability_are_not_claimed_as_resume_differences(service: CareerService, thread: CareerThread, text: str):
    snapshot = service.create_analysis(thread.id).snapshot
    snapshot = snapshot.model_copy(update={"resume": snapshot.resume.model_copy(update={"text": text})})
    assert build_materials(snapshot).payload["resume_condition_differences"] == []


def test_explicit_english_availability_is_compared_by_value(service: CareerService, thread: CareerThread):
    snapshot = service.create_analysis(thread.id).snapshot
    snapshot = snapshot.model_copy(update={"resume": snapshot.resume.model_copy(update={"text": "Availability: 4 days per week, 3 months."})})
    differences = build_materials(snapshot).payload["resume_condition_differences"]
    assert differences[0] == {"field": "days_per_week", "selected": 3, "resume": 4, "evidence": "Availability: 4 days per week, 3 months."}
