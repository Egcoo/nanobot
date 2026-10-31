from __future__ import annotations

from pathlib import Path

import pytest

from nanobot.career.models import CareerThread, PersonalConditions, TaskInput
from nanobot.career.service import CareerService
from nanobot.career.store import CareerStore


@pytest.fixture
def service(tmp_path: Path) -> CareerService:
    return CareerService(CareerStore(tmp_path / "workspace", data_dir=tmp_path / "data"))


@pytest.fixture
def thread(service: CareerService) -> CareerThread:
    resume = service.create_resume(
        name="工程测试简历", text="做过一次产品原型练习。", profile={"interview_experience": None},
    )
    job = service.create_job(
        name="产品实习", company="测试公司 A", text="参与产品原型和用户访谈。",
        requirements={"days_per_week": 4, "location": None},
    )
    service.confirm_resume(resume.id)
    service.confirm_job(job.id)
    return service.create_thread(
        session_key="career:test-session-a", resume_version_id=resume.id, job_version_id=job.id,
        conditions=PersonalConditions(days_per_week=3, available_months=3),
    )


@pytest.fixture
def proposals() -> tuple[TaskInput, ...]:
    return tuple(TaskInput(
        title=f"工程任务 {index}", action=f"整理第 {index} 项项目说明。",
        completion_criteria=f"形成第 {index} 项说明初稿。",
    ) for index in range(1, 4))
