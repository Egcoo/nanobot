"""Workspace-private SQLite storage. All mutations run in explicit transactions."""

from __future__ import annotations

import json
import os
import sqlite3
from collections.abc import Generator
from contextlib import closing, contextmanager, suppress
from pathlib import Path
from typing import TypeVar

from pydantic import BaseModel

from nanobot.career.models import (
    AnalysisRun,
    CareerNotFoundError,
    CareerThread,
    JobVersion,
    PreparationPlan,
    PreparationTask,
    ResumeVersion,
)
from nanobot.config.paths import get_data_dir
from nanobot.session.location import SessionLocation

SCHEMA_VERSION = 2
_Record = TypeVar("_Record", bound=BaseModel)

_SCHEMA = (
    """CREATE TABLE resume_versions (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL UNIQUE CHECK (version > 0),
        parent_version_id TEXT REFERENCES resume_versions(id),
        name TEXT NOT NULL, notes TEXT NOT NULL, source TEXT NOT NULL,
        text TEXT NOT NULL, profile TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'confirmed')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, confirmed_at TEXT
    )""",
    """CREATE TABLE job_versions (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        parent_version_id TEXT REFERENCES job_versions(id),
        name TEXT NOT NULL, company TEXT, source TEXT NOT NULL,
        text TEXT NOT NULL, requirements TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'confirmed')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, confirmed_at TEXT,
        UNIQUE (job_id, version)
    )""",
    """CREATE TABLE career_threads (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_key TEXT NOT NULL UNIQUE,
        resume_version_id TEXT NOT NULL REFERENCES resume_versions(id),
        job_version_id TEXT NOT NULL REFERENCES job_versions(id),
        conditions TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT
    )""",
    """CREATE TABLE analysis_runs (
        id TEXT PRIMARY KEY,
        career_thread_id TEXT NOT NULL REFERENCES career_threads(id),
        snapshot TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        source_reply_id TEXT, result TEXT, usage TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )""",
    """CREATE TABLE preparation_plans (
        id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL REFERENCES analysis_runs(id),
        proposed_tasks TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'confirmed', 'cancelled')),
        created_at TEXT NOT NULL, confirmed_at TEXT
    )""",
    """CREATE TABLE preparation_tasks (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES preparation_plans(id),
        position INTEGER NOT NULL CHECK (position >= 0),
        title TEXT NOT NULL, action TEXT NOT NULL, completion_criteria TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
        result TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (plan_id, position)
    )""",
    "CREATE INDEX analysis_thread_idx ON analysis_runs(career_thread_id, created_at)",
    "CREATE INDEX plans_analysis_idx ON preparation_plans(analysis_id, created_at)",
)


def _parse(model: type[_Record], row: sqlite3.Row, *json_fields: str) -> _Record:
    values: dict[str, object] = {key: row[key] for key in row.keys()}
    for key in json_fields:
        value = values[key]
        if not isinstance(value, str):
            raise ValueError(f"invalid career JSON column: {key}")
        values[key] = json.loads(value)
    return model.model_validate(values)


def _required(row: sqlite3.Row | None, kind: str) -> sqlite3.Row:
    if row is None:
        raise CareerNotFoundError(f"{kind} not found in this workspace")
    return row


def _insert(db: sqlite3.Connection, table: str, record: BaseModel) -> None:
    # Table/column names come only from the fixed store methods and validated models.
    values = record.model_dump(mode="json")
    db.execute(
        f"INSERT INTO {table} ({', '.join(values)}) VALUES ({', '.join('?' for _ in values)})",
        tuple(
            json.dumps(value, ensure_ascii=False, allow_nan=False)
            if isinstance(value, (dict, list)) else value
            for value in values.values()
        ),
    )


class CareerStore:
    """Use the session subsystem's stable workspace identity, with a separate database.

    ``workspace`` and ``data_dir`` are trusted runtime configuration, never client paths.
    Connections are operation-local so stores can be used by multiple gateway workers.
    """

    def __init__(self, workspace: Path, *, data_dir: Path | None = None) -> None:
        base = (data_dir if data_dir is not None else get_data_dir()).expanduser().resolve()
        location = SessionLocation(workspace, sessions_root=base / "sessions")
        self.workspace_id = location.sessions_dir.name
        root = (base / "career").resolve()
        if root == location.workspace or root.is_relative_to(location.workspace):
            raise ValueError("career storage must be outside the agent workspace")
        directory = root / self.workspace_id
        if directory.resolve() != directory:
            raise ValueError("career namespace must not redirect to another directory")
        directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / "career.sqlite3"
        if self.path.is_symlink():
            raise ValueError("career database must not be a symlink")
        with suppress(OSError):
            os.chmod(root, 0o700)
            os.chmod(directory, 0o700)
        self._initialize()
        with suppress(OSError):
            os.chmod(self.path, 0o600)

    @contextmanager
    def _connect(self) -> Generator[sqlite3.Connection, None, None]:
        with closing(sqlite3.connect(self.path, timeout=10, isolation_level=None)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys = ON")
            db.execute("PRAGMA synchronous = FULL")
            yield db

    def _initialize(self) -> None:
        with self._connect() as db:
            db.execute("PRAGMA journal_mode = WAL")
            with db:
                db.execute("BEGIN IMMEDIATE")
                version = db.execute("PRAGMA user_version").fetchone()[0]
                if version not in (0, 1, SCHEMA_VERSION):
                    raise ValueError(f"unsupported career schema_version: {version}")
                if version == 0:
                    for statement in _SCHEMA:
                        db.execute(statement)
                    db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
                elif version == 1:
                    db.execute("ALTER TABLE career_threads ADD COLUMN deleted_at TEXT")
                    db.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    @contextmanager
    def transaction(self, *, write: bool = False) -> Generator[sqlite3.Connection, None, None]:
        with self._connect() as db, db:
            # Lock before reading records used to decide a mutation: no read/write race.
            db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield db

    @staticmethod
    def next_resume_version(db: sqlite3.Connection) -> int:
        return int(db.execute("SELECT COALESCE(MAX(version), 0) + 1 FROM resume_versions").fetchone()[0])

    @staticmethod
    def next_job_version(db: sqlite3.Connection, job_id: str) -> int:
        return int(db.execute(
            "SELECT COALESCE(MAX(version), 0) + 1 FROM job_versions WHERE job_id = ?", (job_id,),
        ).fetchone()[0])

    @staticmethod
    def resume(db: sqlite3.Connection, version_id: str) -> ResumeVersion:
        row = db.execute("SELECT * FROM resume_versions WHERE id = ?", (version_id,)).fetchone()
        return _parse(ResumeVersion, _required(row, "resume version"), "profile")

    @staticmethod
    def resumes(db: sqlite3.Connection) -> list[ResumeVersion]:
        return [_parse(ResumeVersion, row, "profile") for row in db.execute(
            "SELECT * FROM resume_versions ORDER BY version",
        )]

    @staticmethod
    def add_resume(db: sqlite3.Connection, record: ResumeVersion) -> None:
        _insert(db, "resume_versions", record)

    @staticmethod
    def update_resume(db: sqlite3.Connection, record: ResumeVersion) -> None:
        db.execute(
            """UPDATE resume_versions SET name = ?, notes = ?, text = ?, profile = ?,
                status = ?, updated_at = ?, confirmed_at = ? WHERE id = ?""",
            (record.name, record.notes, record.text, json.dumps(record.profile, ensure_ascii=False),
             record.status, record.updated_at.isoformat(),
             record.confirmed_at.isoformat() if record.confirmed_at else None, record.id),
        )

    @staticmethod
    def job(db: sqlite3.Connection, version_id: str) -> JobVersion:
        row = db.execute("SELECT * FROM job_versions WHERE id = ?", (version_id,)).fetchone()
        return _parse(JobVersion, _required(row, "job version"), "requirements")

    @staticmethod
    def jobs(db: sqlite3.Connection) -> list[JobVersion]:
        return [_parse(JobVersion, row, "requirements") for row in db.execute(
            "SELECT * FROM job_versions ORDER BY created_at, id",
        )]

    @staticmethod
    def add_job(db: sqlite3.Connection, record: JobVersion) -> None:
        _insert(db, "job_versions", record)

    @staticmethod
    def update_job(db: sqlite3.Connection, record: JobVersion) -> None:
        db.execute(
            """UPDATE job_versions SET name = ?, company = ?, text = ?, requirements = ?,
                status = ?, updated_at = ?, confirmed_at = ? WHERE id = ?""",
            (record.name, record.company, record.text,
             json.dumps(record.requirements, ensure_ascii=False), record.status,
             record.updated_at.isoformat(),
             record.confirmed_at.isoformat() if record.confirmed_at else None, record.id),
        )

    @staticmethod
    def thread(db: sqlite3.Connection, thread_id: str, *, include_deleted: bool = False) -> CareerThread:
        row = db.execute("SELECT * FROM career_threads WHERE id = ?", (thread_id,)).fetchone()
        record = _parse(CareerThread, _required(row, "preparation thread"), "conditions")
        if record.deleted_at is not None and not include_deleted:
            raise CareerNotFoundError("preparation thread has been removed")
        return record

    @staticmethod
    def thread_for_session(db: sqlite3.Connection, session_key: str) -> CareerThread | None:
        row = db.execute("SELECT * FROM career_threads WHERE session_key = ?", (session_key,)).fetchone()
        return _parse(CareerThread, row, "conditions") if row is not None else None

    @staticmethod
    def threads(db: sqlite3.Connection, *, include_deleted: bool = False) -> list[CareerThread]:
        return [_parse(CareerThread, row, "conditions") for row in db.execute(
            "SELECT * FROM career_threads " + ("" if include_deleted else "WHERE deleted_at IS NULL ") + "ORDER BY created_at, id",
        )]

    @staticmethod
    def retire_thread(db: sqlite3.Connection, record: CareerThread) -> None:
        assert record.deleted_at is not None
        db.execute("UPDATE career_threads SET deleted_at = ? WHERE id = ?", (record.deleted_at.isoformat(), record.id))

    @staticmethod
    def add_thread(db: sqlite3.Connection, record: CareerThread) -> None:
        _insert(db, "career_threads", record)

    @staticmethod
    def analysis(db: sqlite3.Connection, analysis_id: str) -> AnalysisRun:
        row = db.execute("SELECT * FROM analysis_runs WHERE id = ?", (analysis_id,)).fetchone()
        return _parse(AnalysisRun, _required(row, "analysis"), "snapshot", "usage")

    @staticmethod
    def analyses(db: sqlite3.Connection, thread_id: str) -> list[AnalysisRun]:
        return [_parse(AnalysisRun, row, "snapshot", "usage") for row in db.execute(
            "SELECT * FROM analysis_runs WHERE career_thread_id = ? ORDER BY created_at, id",
            (thread_id,),
        )]

    @staticmethod
    def analysis_for_turn(db: sqlite3.Connection, thread_id: str, turn_id: str) -> AnalysisRun | None:
        row = db.execute(
            """SELECT * FROM analysis_runs WHERE career_thread_id = ?
                AND json_extract(snapshot, '$.turn_id') = ? ORDER BY created_at LIMIT 1""",
            (thread_id, turn_id),
        ).fetchone()
        return _parse(AnalysisRun, row, "snapshot", "usage") if row is not None else None

    @staticmethod
    def add_analysis(db: sqlite3.Connection, record: AnalysisRun) -> None:
        _insert(db, "analysis_runs", record)

    @staticmethod
    def update_analysis(db: sqlite3.Connection, record: AnalysisRun) -> None:
        # The input snapshot and thread association are immutable, including on retry.
        db.execute(
            """UPDATE analysis_runs SET status = ?, source_reply_id = ?, result = ?,
                usage = ?, updated_at = ? WHERE id = ?""",
            (record.status, record.source_reply_id, record.result, json.dumps(record.usage),
             record.updated_at.isoformat(), record.id),
        )

    @staticmethod
    def plan(db: sqlite3.Connection, plan_id: str) -> PreparationPlan:
        row = db.execute("SELECT * FROM preparation_plans WHERE id = ?", (plan_id,)).fetchone()
        return _parse(PreparationPlan, _required(row, "preparation plan"), "proposed_tasks")

    @staticmethod
    def plans(db: sqlite3.Connection, thread_id: str) -> list[PreparationPlan]:
        return [_parse(PreparationPlan, row, "proposed_tasks") for row in db.execute(
            """SELECT p.* FROM preparation_plans p JOIN analysis_runs a ON a.id = p.analysis_id
                WHERE a.career_thread_id = ? ORDER BY p.created_at, p.id""", (thread_id,),
        )]

    @staticmethod
    def add_plan(db: sqlite3.Connection, record: PreparationPlan) -> None:
        _insert(db, "preparation_plans", record)

    @staticmethod
    def update_plan(db: sqlite3.Connection, record: PreparationPlan) -> None:
        db.execute(
            "UPDATE preparation_plans SET status = ?, confirmed_at = ? WHERE id = ?",
            (record.status, record.confirmed_at.isoformat() if record.confirmed_at else None, record.id),
        )

    @staticmethod
    def cancel_draft_plans(db: sqlite3.Connection, analysis_id: str) -> None:
        db.execute(
            "UPDATE preparation_plans SET status = 'cancelled' WHERE analysis_id = ? AND status = 'draft'",
            (analysis_id,),
        )

    @staticmethod
    def task(db: sqlite3.Connection, task_id: str) -> PreparationTask:
        row = db.execute("SELECT * FROM preparation_tasks WHERE id = ?", (task_id,)).fetchone()
        return _parse(PreparationTask, _required(row, "preparation task"))

    @staticmethod
    def tasks(db: sqlite3.Connection, plan_id: str) -> list[PreparationTask]:
        return [_parse(PreparationTask, row) for row in db.execute(
            "SELECT * FROM preparation_tasks WHERE plan_id = ? ORDER BY position", (plan_id,),
        )]

    @staticmethod
    def add_task(db: sqlite3.Connection, record: PreparationTask) -> None:
        _insert(db, "preparation_tasks", record)

    @staticmethod
    def update_task(db: sqlite3.Connection, record: PreparationTask) -> None:
        db.execute(
            "UPDATE preparation_tasks SET status = ?, result = ?, updated_at = ? WHERE id = ?",
            (record.status, record.result, record.updated_at.isoformat(), record.id),
        )
