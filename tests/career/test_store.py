from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from nanobot.career.service import CareerService
from nanobot.career.store import SCHEMA_VERSION, CareerStore


def test_default_store_uses_active_instance_data_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    data_dir = tmp_path / "active-instance"
    monkeypatch.setattr("nanobot.career.store.get_data_dir", lambda: data_dir)
    workspace = tmp_path / "workspace"
    store = CareerStore(workspace)
    assert store.path == data_dir / "career" / store.workspace_id / "career.sqlite3"
    assert not store.path.is_relative_to(workspace)
    assert (workspace / ".nanobot" / "workspace-id").read_text().strip() == store.workspace_id
    with closing(sqlite3.connect(store.path)) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        assert db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"


def test_same_workspace_in_separate_instances_does_not_share_career_data(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    first = CareerService(CareerStore(workspace, data_dir=tmp_path / "instance-a"))
    second = CareerService(CareerStore(workspace, data_dir=tmp_path / "instance-b"))
    first.create_resume(name="工程测试简历", text="仅存在于实例 A")
    assert first.store.workspace_id == second.store.workspace_id
    assert first.store.path != second.store.path
    assert second.list_resumes() == []


def test_future_schema_is_rejected_without_reinitializing_records(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    data_dir = tmp_path / "data"
    service = CareerService(CareerStore(workspace, data_dir=data_dir))
    record = service.create_resume(name="工程测试简历", text="保留的资料")
    with closing(sqlite3.connect(service.store.path)) as db, db:
        db.execute(f"PRAGMA user_version = {SCHEMA_VERSION + 1}")
    with pytest.raises(ValueError, match="schema_version"):
        CareerStore(workspace, data_dir=data_dir)
    with closing(sqlite3.connect(service.store.path)) as db:
        assert db.execute("SELECT text FROM resume_versions WHERE id = ?", (record.id,)).fetchone()[0] == record.text
        assert db.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION + 1


def test_runtime_storage_inside_workspace_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="outside the agent workspace"):
        CareerStore(tmp_path / "workspace", data_dir=tmp_path / "workspace" / "runtime")


def test_v1_database_upgrade_preserves_materials_bindings_and_analysis(tmp_path: Path) -> None:
    store = CareerStore(tmp_path / "workspace", data_dir=tmp_path / "data")
    service = CareerService(store)
    resume = service.create_resume(name="旧版简历", text="原有项目内容")
    job = service.create_job(name="旧版岗位", text="原有岗位要求")
    service.confirm_resume(resume.id)
    service.confirm_job(job.id)
    thread = service.create_thread(session_key="career:migration", resume_version_id=resume.id, job_version_id=job.id)
    analysis = service.create_analysis(thread.id, turn_id="existing-turn")
    # Reproduce the previous on-disk schema, which had no deletion marker.
    with closing(sqlite3.connect(store.path)) as db, db:
        db.execute("ALTER TABLE career_threads DROP COLUMN deleted_at")
        db.execute("PRAGMA user_version = 1")
    restored = CareerService(CareerStore(tmp_path / "workspace", data_dir=tmp_path / "data"))
    assert restored.get_thread(thread.id) == thread
    assert restored.get_resume(resume.id).text == resume.text
    assert restored.get_job(job.id).text == job.text
    assert restored.get_analysis(analysis.id) == analysis
    with closing(sqlite3.connect(store.path)) as db:
        assert db.execute("PRAGMA user_version").fetchone()[0] == 2
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
