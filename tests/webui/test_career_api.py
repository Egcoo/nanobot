from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from websockets.datastructures import Headers
from websockets.http11 import Request, Response

from nanobot.bus.outbound_events import (
    StreamDeltaEvent,
    StreamEndEvent,
    TurnEndEvent,
    TurnModelUpdatedEvent,
    outbound_message_for_event,
)
from nanobot.bus.queue import MessageBus
from nanobot.channels.manager import ChannelManager
from nanobot.channels.websocket.runtime import WebSocketChannel, WebSocketConfig
from nanobot.runtime_context import RUNTIME_CONTEXT_INPUT_META
from nanobot.security.workspace_access import WORKSPACE_SCOPE_METADATA_KEY
from nanobot.session.manager import SessionManager
from nanobot.webui.career_turns import CAREER_TURN_METADATA
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


async def test_deleting_chat_retires_its_preparation_and_reentry_gets_a_fresh_chat(gateway):
    reference = await _scope(gateway)
    resume, job = await _confirmed_pair(gateway, reference)
    payload = dict(workspace_ref=reference, resume_version_id=resume["id"], job_version_id=job["id"])
    thread = _body(await _mutate(gateway, "career.thread.create", **payload))
    service, _ = gateway[0].http.career.bound_thread(reference, thread["id"])
    analysis = service.create_analysis(thread["id"])
    deleted = await _mutate(gateway, "session.delete", key=thread["session_key"])
    assert _body(deleted)["deleted"] is True
    state = _body(await _get(gateway, f"/api/career?workspace_ref={reference}"))
    assert state["threads"] == [] and state["deleted_thread_ids"] == [thread["id"]]
    assert state["resumes"][0]["id"] == resume["id"] and state["jobs"][0]["id"] == job["id"]
    assert service.get_thread(thread["id"], include_deleted=True).deleted_at is not None
    assert service.get_analysis(analysis.id).status == "cancelled"
    assert (await _get(gateway, f"/api/career/conversation?workspace_ref={reference}&thread_id={thread['id']}")).status_code == 404
    fresh = _body(await _mutate(gateway, "career.thread.create", **payload))
    assert fresh["id"] != thread["id"] and fresh["session_key"] != thread["session_key"]
    assert _body(await _mutate(gateway, "career.thread.create", **payload)) == fresh


async def test_old_deleted_chat_is_reconciled_but_read_errors_do_not_retire_a_preparation(gateway, monkeypatch):
    reference = await _scope(gateway)
    resume, job = await _confirmed_pair(gateway, reference)
    thread = _body(await _mutate(gateway, "career.thread.create", workspace_ref=reference,
                                resume_version_id=resume["id"], job_version_id=job["id"]))
    service, _ = gateway[0].http.career.bound_thread(reference, thread["id"])
    reader = gateway[0].session_manager.read_session_metadata

    def unavailable(_key):
        raise OSError("temporary read failure")

    monkeypatch.setattr(gateway[0].session_manager, "read_session_metadata", unavailable)
    assert (await _get(gateway, f"/api/career?workspace_ref={reference}")).status_code == 503
    assert service.get_thread(thread["id"]).deleted_at is None
    monkeypatch.setattr(gateway[0].session_manager, "read_session_metadata", reader)
    await gateway[0].session_manager.state.delete(thread["session_key"])
    state = _body(await _get(gateway, f"/api/career?workspace_ref={reference}"))
    assert state["threads"] == [] and state["deleted_thread_ids"] == [thread["id"]]
    assert service.get_thread(thread["id"], include_deleted=True).deleted_at is not None


async def test_failed_chat_deletion_keeps_the_preparation_active(gateway):
    reference = await _scope(gateway)
    resume, job = await _confirmed_pair(gateway, reference)
    thread = _body(await _mutate(gateway, "career.thread.create", workspace_ref=reference,
                                resume_version_id=resume["id"], job_version_id=job["id"]))

    async def failed_delete():
        raise OSError("temporary write failure")

    with pytest.raises(OSError):
        await gateway[0].http.career.delete_session(thread["session_key"], failed_delete)
    state = _body(await _get(gateway, f"/api/career?workspace_ref={reference}"))
    assert state["threads"][0]["id"] == thread["id"] and state["deleted_thread_ids"] == []


async def test_state_read_waits_for_new_preparation_binding_before_reconciling_missing_sessions(gateway, monkeypatch):
    reference = await _scope(gateway)
    resume, job = await _confirmed_pair(gateway, reference)
    entered, release = asyncio.Event(), asyncio.Event()
    mutate = gateway[0].session_manager.state.mutate_metadata

    async def delayed_bind(*args, **kwargs):
        entered.set()
        await release.wait()
        return await mutate(*args, **kwargs)

    monkeypatch.setattr(gateway[0].session_manager.state, "mutate_metadata", delayed_bind)
    creation = asyncio.create_task(_mutate(gateway, "career.thread.create", workspace_ref=reference,
                                         resume_version_id=resume["id"], job_version_id=job["id"]))
    await asyncio.wait_for(entered.wait(), 5)
    read = asyncio.create_task(_get(gateway, f"/api/career?workspace_ref={reference}"))
    try:
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(asyncio.shield(read), 0.05)
        release.set()
        thread = _body(await creation)
        state = _body(await read)
        assert state["threads"][0]["id"] == thread["id"] and state["deleted_thread_ids"] == []
    finally:
        release.set()
        await asyncio.gather(creation, read, return_exceptions=True)


class _CareerConnection:
    remote_address = ("127.0.0.1", 32001)
    request = Request("/", Headers())

    def __init__(self):
        self.sent = []

    async def send(self, raw):
        self.sent.append(json.loads(raw))


async def _career_turn(gateway, *, unified=False, turn_id="career-turn", ordinary=False):
    services = replace(gateway[0], unified_session=unified)
    reference = await _scope(gateway)
    resume, job = await _confirmed_pair(gateway, reference)
    thread = _body(await _mutate(gateway, "career.thread.create", workspace_ref=reference,
                                resume_version_id=resume["id"], job_version_id=job["id"]))
    chat_id = "ordinary-question" if ordinary else thread["session_key"].split(":", 1)[1]
    channel = WebSocketChannel(WebSocketConfig(), services.http.bus, gateway=services)
    connection = _CareerConnection()
    channel._webui_connections.add(connection)
    await channel._dispatch_envelope(connection, "browser", {
        "type": "message", "chat_id": chat_id, "turn_id": turn_id, "webui": True,
        "content": "根据我的资料，应该先准备什么？",
    })
    message = await services.http.bus.consume_inbound()
    return channel, connection, message, reference, thread


async def test_conversation_preview_is_authenticated_and_rejects_wrong_session_scope(gateway, tmp_path: Path):
    reference = await _scope(gateway)
    resume, job = await _confirmed_pair(gateway, reference)
    thread = _body(await _mutate(gateway, "career.thread.create", workspace_ref=reference,
                                resume_version_id=resume["id"], job_version_id=job["id"]))
    path = f"/api/career/conversation?workspace_ref={reference}&thread_id={thread['id']}"
    assert (await _get(gateway, path, authenticated=False)).status_code == 401
    response = await _get(gateway, path)
    assert response.status_code == 200 and response.headers["Cache-Control"] == "no-store"
    preview = _body(response)
    assert preview["thread_id"] == thread["id"] and preview["analyses"] == []
    assert preview["preview"]["resume"]["text"] == resume["text"]
    await gateway[0].session_manager.state.update_metadata(thread["session_key"], {
        WORKSPACE_SCOPE_METADATA_KEY: {"project_path": str(tmp_path / "wrong"), "access_mode": "restricted"},
    })
    assert (await _get(gateway, path)).status_code == 409


@pytest.mark.parametrize("unified", [False, True])
async def test_career_message_has_bound_context_and_its_own_execution_session(gateway, unified):
    channel, connection, message, reference, thread = await _career_turn(gateway, unified=unified)
    try:
        assert message.session_key == thread["session_key"]
        assert message.session_key_override == thread["session_key"]
        blocks = message.metadata[RUNTIME_CONTEXT_INPUT_META]
        assert {block.source for block in blocks} >= {"career_guidance", "career_materials"}
        assert "一次原型练习" in "\n".join(block.content for block in blocks)
        source = message.metadata[CAREER_TURN_METADATA]
        service, _ = gateway[0].http.career.bound_thread(reference, thread["id"])
        analysis = service.get_analysis(source["analysis_id"])
        assert analysis.snapshot.turn_id == "career-turn"
        service.rename_resume(thread["resume_version_id"], name="修改后的名称", notes="")
        assert service.get_analysis(analysis.id).snapshot.resume.name == "工程简历"
    finally:
        await channel._cleanup_connection(connection)


async def test_ordinary_message_does_not_receive_career_material(gateway):
    channel, connection, message, _, _ = await _career_turn(gateway, ordinary=True)
    try:
        assert CAREER_TURN_METADATA not in message.metadata
        assert not any(block.source.startswith("career") for block in message.metadata.get(RUNTIME_CONTEXT_INPUT_META, []))
    finally:
        await channel._cleanup_connection(connection)


async def test_late_output_after_chat_deletion_cannot_restore_the_preparation_or_session(gateway):
    channel, connection, message, reference, thread = await _career_turn(gateway)
    service, _ = gateway[0].http.career.bound_thread(reference, thread["id"])
    analysis_id = message.metadata[CAREER_TURN_METADATA]["analysis_id"]

    async def deliver(event):
        await ChannelManager._send_once(channel, outbound_message_for_event(
            channel="websocket", chat_id=message.chat_id, event=event, metadata=message.metadata,
        ))

    try:
        await deliver(TurnModelUpdatedEvent(model="engineering"))
        assert _body(await _mutate(gateway, "session.delete", key=thread["session_key"]))["deleted"] is True
        await deliver(StreamDeltaEvent(content="迟到的片段", stream_id="late"))
        await deliver(StreamEndEvent(stream_id="late"))
        await deliver(TurnEndEvent(outcome="completed"))
        assert service.get_analysis(analysis_id).status == "cancelled"
        assert gateway[0].session_manager.read_session_metadata(thread["session_key"]) is None
        state = _body(await _get(gateway, f"/api/career?workspace_ref={reference}"))
        assert state["threads"] == [] and state["deleted_thread_ids"] == [thread["id"]]
    finally:
        await channel._cleanup_connection(connection)


async def test_stop_command_uses_the_career_session_even_when_ordinary_chat_is_unified(gateway):
    channel, connection, original, reference, thread = await _career_turn(gateway, unified=True)
    try:
        await channel._dispatch_envelope(connection, "browser", {
            "type": "message", "chat_id": original.chat_id, "turn_id": "stop-turn", "webui": True,
            "content": "/stop",
        })
        command = await gateway[0].http.bus.consume_inbound()
        assert command.session_key == thread["session_key"]
        assert CAREER_TURN_METADATA not in command.metadata
        service, _ = gateway[0].http.career.bound_thread(reference, thread["id"])
        assert len(service.list_analyses(thread["id"])) == 1
        assert service.list_analyses(thread["id"])[0].status == "cancelled"
    finally:
        await channel._cleanup_connection(connection)


async def test_immediate_stop_without_nonce_waits_for_the_career_question_admission(gateway, monkeypatch):
    channel, connection, message, reference, thread = await _career_turn(gateway)
    entered, release = asyncio.Event(), asyncio.Event()
    dispatch_order = []
    original = channel._commands._dispatch_message_once

    async def delayed_admission(connection, client_id, envelope):
        if envelope.get("turn_id") == "slow-admission":
            entered.set()
            await release.wait()
        dispatch_order.append(envelope["content"])
        await original(connection, client_id, envelope)

    monkeypatch.setattr(channel._commands, "_dispatch_message_once", delayed_admission)
    question = asyncio.create_task(channel._dispatch_envelope(connection, "browser", {
        "type": "message", "chat_id": message.chat_id, "turn_id": "slow-admission", "webui": True,
        "content": "第二个工程问题",
    }))
    await asyncio.wait_for(entered.wait(), 5)
    stop = asyncio.create_task(channel._dispatch_envelope(connection, "browser", {
        "type": "message", "chat_id": message.chat_id, "webui": True, "content": "/stop",
    }))
    try:
        # Give the stop coroutine a turn while the earlier question is held.
        await asyncio.sleep(0)
        release.set()
        await asyncio.wait_for(asyncio.gather(question, stop), 10)
        assert dispatch_order == ["第二个工程问题", "/stop"]
        assert (await gateway[0].http.bus.consume_inbound()).content == "第二个工程问题"
        assert (await gateway[0].http.bus.consume_inbound()).content == "/stop"
        service, _ = gateway[0].http.career.bound_thread(reference, thread["id"])
        assert {item.status for item in service.list_analyses(thread["id"])} == {"cancelled"}
    finally:
        release.set()
        await asyncio.gather(question, stop, return_exceptions=True)
        await channel._cleanup_connection(connection)


@pytest.mark.parametrize("outcome", ["completed", "failed", "cancelled"])
async def test_career_stream_records_final_result_or_failure_against_original_snapshot(gateway, outcome):
    channel, connection, message, reference, thread = await _career_turn(gateway)
    try:
        service, _ = gateway[0].http.career.bound_thread(reference, thread["id"])
        analysis_id = message.metadata[CAREER_TURN_METADATA]["analysis_id"]
        async def deliver(event):
            await ChannelManager._send_once(channel, outbound_message_for_event(
                channel="websocket", chat_id=message.chat_id, event=event, metadata=message.metadata,
            ))
        await deliver(StreamDeltaEvent(content="先整理", stream_id="one"))
        await deliver(StreamDeltaEvent(content="一个项目案例，并确认访谈经历。", stream_id="one"))
        await deliver(StreamEndEvent(stream_id="one"))
        await deliver(TurnEndEvent(outcome=outcome, failure_kind="model" if outcome == "failed" else None))
        stored = service.get_analysis(analysis_id)
        assert stored.status == {"completed": "succeeded", "failed": "failed", "cancelled": "cancelled"}[outcome]
        assert stored.result == "先整理一个项目案例，并确认访谈经历。"
        assert stored.snapshot.turn_id == "career-turn"
        assert service.list_plans(thread["id"]) == []
        response = _body(await _get(gateway, f"/api/career/conversation?workspace_ref={reference}&thread_id={thread['id']}"))
        assert response["analyses"][0]["id"] == stored.id
        assert response["analyses"][0]["resume_name"] == "工程简历"
    finally:
        await channel._cleanup_connection(connection)


async def test_runtime_recovery_records_the_reply_using_the_failed_turn_original_snapshot(gateway):
    channel, connection, message, reference, thread = await _career_turn(gateway)
    try:
        service, _ = gateway[0].http.career.bound_thread(reference, thread["id"])
        analysis_id = message.metadata[CAREER_TURN_METADATA]["analysis_id"]
        async def deliver(event):
            await ChannelManager._send_once(channel, outbound_message_for_event(channel="websocket", chat_id=message.chat_id, event=event, metadata=message.metadata))
        await deliver(TurnEndEvent(outcome="failed", failure_kind="model"))
        original = service.get_analysis(analysis_id).snapshot
        service.rename_resume(thread["resume_version_id"], name="新名称", notes="")
        await deliver(TurnModelUpdatedEvent(model="engineering"))
        await deliver(StreamEndEvent(content="恢复后的工程回复"))
        await deliver(TurnEndEvent(outcome="completed"))
        recovered = service.get_analysis(analysis_id)
        assert recovered.status == "succeeded" and recovered.snapshot == original
        assert recovered.result == "恢复后的工程回复"
    finally:
        await channel._cleanup_connection(connection)


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
