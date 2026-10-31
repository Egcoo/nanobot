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
