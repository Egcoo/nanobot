from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from websockets.datastructures import Headers
from websockets.http11 import Request, Response

from nanobot.bus.queue import MessageBus
from nanobot.channels.websocket.runtime import WebSocketConfig
from nanobot.security.workspace_access import WORKSPACE_SCOPE_METADATA_KEY
from nanobot.session.manager import SessionManager
from nanobot.webui.gateway_services import build_gateway_services
from nanobot.webui.workspaces import write_webui_workspace_state


@pytest.fixture
async def gateway(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    data = tmp_path / "data"
    data.mkdir()
    config_path = data / "config.json"
    config_path.write_text("{}", encoding="utf-8")
    monkeypatch.setattr("nanobot.config.paths.get_data_dir", lambda: data)
    workspace = tmp_path / "workspace"
    sessions = SessionManager(workspace, sessions_root=data / "sessions")
    services = build_gateway_services(
        config=WebSocketConfig(), bus=MessageBus(), session_manager=sessions,
        static_dist_path=None, workspace_path=workspace, default_restrict_to_workspace=True,
        config_path=config_path, runtime_model_name=lambda: None, runtime_surface="browser",
        runtime_capabilities_overrides=None,
    )
    token = services.tokens.issue_api_token(60)
    connection = SimpleNamespace(
        remote_address=("127.0.0.1", 32100), request=Request("/", Headers()),
    )
    try:
        yield services, token, connection
    finally:
        await sessions.state.aclose()


def _body(response: Response) -> dict:
    return json.loads(bytes(response.body))


async def _get(gateway, path: str, *, authenticated: bool = True) -> Response:
    services, token, connection = gateway
    headers = Headers({"Authorization": f"Bearer {token}"}) if authenticated else Headers()
    return await services.http.dispatch(connection, Request(path, headers))


async def _mutate(gateway, action: str, **payload) -> Response:
    services, _, connection = gateway
    return await services.http.dispatch_webui_mutation(connection, action, payload)


async def _scope(gateway) -> str:
    response = await _get(gateway, "/api/career/workspaces")
    assert response.status_code == 200
    return _body(response)["workspaces"][0]["ref"]


async def _confirmed_pair(gateway, reference: str) -> tuple[dict, dict]:
    resume = _body(await _mutate(
        gateway, "career.resume.create", workspace_ref=reference, name="工程简历", text="一次原型练习",
    ))
    job = _body(await _mutate(
        gateway, "career.job.create", workspace_ref=reference, name="工程岗位", text="参与原型设计",
    ))
    assert (await _mutate(gateway, "career.resume.confirm", workspace_ref=reference, id=resume["id"])).status_code == 200
    assert (await _mutate(gateway, "career.job.confirm", workspace_ref=reference, id=job["id"])).status_code == 200
    return resume, job


async def test_reads_require_current_auth_and_mutations_reject_http(gateway, tmp_path: Path):
    assert (await _get(gateway, "/api/career/workspaces", authenticated=False)).status_code == 401
    assert (await _get(gateway, "/api/career?workspace_ref=arbitrary", authenticated=False)).status_code == 401
    assert not (tmp_path / "data/career").exists()
    direct = await _get(gateway, "/api/career/mutate/career.resume.create")
    assert direct.status_code == 405
    assert not (tmp_path / "data/career").exists()
    reference = await _scope(gateway)
    response = await _get(gateway, f"/api/career?workspace_ref={reference}")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert _body(response)["resumes"] == []
    gateway[0].tokens.clear()
    assert (await _get(gateway, f"/api/career?workspace_ref={reference}")).status_code == 401


async def test_resume_ui_actions_save_draft_metadata_atomically_and_preserve_versions(gateway):
    reference = await _scope(gateway)
    first = _body(await _mutate(gateway, "career.resume.create", workspace_ref=reference, name="同名简历", text="旧正文"))
    second = _body(await _mutate(gateway, "career.resume.create", workspace_ref=reference, name="同名简历", text="另一个版本"))
    assert first["id"] != second["id"]
    edited = await _mutate(gateway, "career.resume.edit", workspace_ref=reference, id=first["id"], name="改名", notes="新备注", text="新正文")
    assert edited.status_code == 200
    assert (_body(edited)["name"], _body(edited)["notes"], _body(edited)["text"]) == ("改名", "新备注", "新正文")
    invalid = await _mutate(gateway, "career.resume.edit", workspace_ref=reference, id=first["id"], name="", text="不应保存")
    assert invalid.status_code == 400
    await _mutate(gateway, "career.resume.confirm", workspace_ref=reference, id=first["id"])
    denied = await _mutate(gateway, "career.resume.edit", workspace_ref=reference, id=first["id"], name="覆盖", text="不应覆盖")
    assert denied.status_code == 409
    revised = _body(await _mutate(gateway, "career.resume.revise", workspace_ref=reference, id=first["id"], name="另存", text="另存正文"))
    assert revised["parent_version_id"] == first["id"] and revised["status"] == "draft"
    renamed = await _mutate(gateway, "career.resume.rename", workspace_ref=reference, id=first["id"], name="归档", notes="已核对")
    assert renamed.status_code == 200 and _body(renamed)["text"] == "新正文"
    state = _body(await _get(gateway, f"/api/career?workspace_ref={reference}"))
    assert len(state["resumes"]) == 3


async def test_job_revisions_can_clear_company_without_changing_old_record(gateway):
    reference = await _scope(gateway)
    first = _body(await _mutate(gateway, "career.job.create", workspace_ref=reference, name="实习", company="原公司", text="原要求"))
    edited = await _mutate(gateway, "career.job.edit", workspace_ref=reference, id=first["id"], name="实习", company="原公司", text="每周三天")
    assert edited.status_code == 200
    await _mutate(gateway, "career.job.confirm", workspace_ref=reference, id=first["id"])
    revised = _body(await _mutate(gateway, "career.job.revise", workspace_ref=reference, id=first["id"], name="新要求", company=None, text="每周四天"))
    assert revised["company"] is None
    state = _body(await _get(gateway, f"/api/career?workspace_ref={reference}"))
    old = next(item for item in state["jobs"] if item["id"] == first["id"])
    assert old["company"] == "原公司" and old["text"] == "每周三天"


async def test_thread_creation_owns_real_session_and_repeated_entry_reuses_it(gateway):
    reference = await _scope(gateway)
    resume, job = await _confirmed_pair(gateway, reference)
    payload = dict(workspace_ref=reference, resume_version_id=resume["id"], job_version_id=job["id"], conditions={"days_per_week": 3})
    first = await _mutate(gateway, "career.thread.create", **payload)
    assert first.status_code == 200
    thread = _body(first)
    assert _body(await _mutate(gateway, "career.thread.create", **payload)) == thread
    metadata = await gateway[0].session_manager.state.read_metadata(thread["session_key"])
    assert metadata["metadata"]["career_thread_id"] == thread["id"]
    assert metadata["metadata"][WORKSPACE_SCOPE_METADATA_KEY]["project_path"] == str(gateway[0].session_manager.workspace)
    second = _body(await _mutate(gateway, "career.thread.create", **{**payload, "conditions": {"days_per_week": 4}}))
    assert second["id"] != thread["id"]
    state = _body(await _get(gateway, f"/api/career?workspace_ref={reference}"))
    assert len(state["threads"]) == 2 and state["chat_available"][thread["id"]] is True
    await gateway[0].session_manager.state.update_metadata(thread["session_key"], {WORKSPACE_SCOPE_METADATA_KEY: {"project_path": str(gateway[0].session_manager.workspace), "access_mode": "full"}})
    assert _body(await _mutate(gateway, "career.thread.create", **payload)) == thread
    assert (await gateway[0].session_manager.state.read_metadata(thread["session_key"]))["metadata"][WORKSPACE_SCOPE_METADATA_KEY]["access_mode"] == "full"


async def test_client_cannot_supply_paths_session_keys_or_confirmation_state(gateway, tmp_path: Path):
    reference = await _scope(gateway)
    response = await _mutate(gateway, "career.resume.create", workspace_ref=reference, name="测试", text="正文", status="confirmed")
    assert response.status_code == 400
    response = await _mutate(gateway, "career.resume.create", workspace_ref=reference, name="测试", text="正文", workspace_path=str(tmp_path))
    assert response.status_code == 400
    resume, job = await _confirmed_pair(gateway, reference)
    response = await _mutate(gateway, "career.thread.create", workspace_ref=reference, resume_version_id=resume["id"], job_version_id=job["id"], session_key="websocket:unrelated")
    assert response.status_code == 400
    assert await gateway[0].session_manager.state.read_metadata("websocket:unrelated") is None
    assert (await _get(gateway, "/api/career?workspace_ref=../../other")).status_code == 404


async def test_server_known_workspaces_remain_isolated(gateway, tmp_path: Path):
    default = await _scope(gateway)
    project = tmp_path / "known-project"
    project.mkdir()
    write_webui_workspace_state({"favorite_projects": [str(project)]})
    catalog = _body(await _get(gateway, "/api/career/workspaces"))["workspaces"]
    other = next(item["ref"] for item in catalog if not item["is_default"])
    resume, job = await _confirmed_pair(gateway, default)
    state = _body(await _get(gateway, f"/api/career?workspace_ref={other}"))
    assert state["resumes"] == [] and state["threads"] == []
    denied = await _mutate(gateway, "career.thread.create", workspace_ref=other, resume_version_id=resume["id"], job_version_id=job["id"])
    assert denied.status_code == 404
    assert (await _mutate(gateway, "career.resume.confirm", workspace_ref=other, id=resume["id"])).status_code == 404


async def test_session_scope_mismatch_does_not_rebind_or_overwrite_history(gateway, tmp_path: Path):
    reference = await _scope(gateway)
    resume, job = await _confirmed_pair(gateway, reference)
    payload = dict(workspace_ref=reference, resume_version_id=resume["id"], job_version_id=job["id"])
    thread = _body(await _mutate(gateway, "career.thread.create", **payload))
    changed = {"project_path": str(tmp_path / "another-project"), "access_mode": "default"}
    await gateway[0].session_manager.state.update_metadata(thread["session_key"], {WORKSPACE_SCOPE_METADATA_KEY: changed})
    assert (await _mutate(gateway, "career.thread.create", **payload)).status_code == 409
    state = _body(await _get(gateway, f"/api/career?workspace_ref={reference}"))
    assert state["chat_available"][thread["id"]] is False
    metadata = await gateway[0].session_manager.state.read_metadata(thread["session_key"])
    assert metadata["metadata"][WORKSPACE_SCOPE_METADATA_KEY] == changed


async def test_paused_runtime_does_not_initialize_or_mutate_career_storage(gateway, tmp_path: Path):
    services, _, _ = gateway
    reference = await _scope(gateway)
    with services.http.bus.admission.pause_before_start():
        assert (await _get(gateway, f"/api/career?workspace_ref={reference}")).status_code == 503
        response = await _mutate(gateway, "career.resume.create", workspace_ref=reference, name="测试", text="正文")
        assert response.status_code == 503
    assert not (tmp_path / "data/career").exists()
