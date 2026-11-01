"""Disposable browser gateway with a synthetic provider by default.

Run only with a disposable --root. stdin 'stop' closes the listener and sessions;
restarting with the same root verifies actual process restart recovery.
--configured-model uses the existing provider configuration for an explicitly
requested live smoke check. Credentials are never copied into the test config.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from collections.abc import Awaitable
from contextlib import suppress
from pathlib import Path
from typing import Any

import httpx

from nanobot.agent.loop import AgentLoop
from nanobot.agent.tools.context import current_request_context
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.bus.queue import MessageBus
from nanobot.channels.manager import ChannelManager
from nanobot.channels.websocket.runtime import WebSocketChannel, WebSocketConfig
from nanobot.config.home import set_home_path
from nanobot.config.loader import load_config, set_config_path
from nanobot.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from nanobot.providers.factory import build_provider_snapshot
from nanobot.session.manager import SessionManager
from nanobot.session.webui_turns import WebuiTurnCoordinator
from nanobot.webui.career_policy import career_discussion_policy
from nanobot.webui.career_tools import ProposePreparationPlanTool
from nanobot.webui.gateway_services import build_gateway_services
from nanobot.webui.history import fact_from_record
from nanobot.webui.workspaces import write_webui_workspace_state


class EngineeringProvider(LLMProvider):
    def __init__(self) -> None:
        super().__init__(provider_name="engineering-test")
        self.waited = False

    def get_default_model(self) -> str:
        return "career-engineering-model"

    async def chat(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None,
        model: str | None = None, max_tokens: int = 4096, temperature: float = 0.7,
        reasoning_effort: str | None = None, tool_choice: str | dict[str, Any] | None = None,
    ) -> LLMResponse:
        current = str(messages[-1]["content"])
        if messages[-1]["role"] == "tool":
            return LLMResponse(content="工程测试：准备草稿已生成，请在界面核对并确认。" if '"draft_id"' in current else "工程测试：工具未生成草稿。", finish_reason="stop")
        context = current_request_context()
        intent = context.original_user_text if context and context.original_user_text else current
        if "准备计划" in intent:
            project = "CV_C9" if "CV_C9" in current else "CV_A7"
            tasks = [
                {"title": "整理项目说明", "action": f"将 {project} 的问题、方案与验证过程整理为一页。", "completion_criteria": "完成一页项目说明，区分已有结果与待确认事项。", "basis": f"简历包含 {project} 项目，可以从现有经历准备项目表达。"},
                {"title": "核对岗位要求", "action": "逐条对照 JOB_B4 原文，缺失经历标为待确认。", "completion_criteria": "完成一页岗位对照表，列明证据和待确认项。", "basis": "岗位要求用户访谈经历，简历尚未说明，应先核对。"},
                {"title": "准备项目口述", "action": f"围绕 {project} 练习两分钟项目介绍。", "completion_criteria": "完成一份可以在两分钟内讲清的提纲。", "basis": "可以基于已确认项目准备口述，不需要编造额外经历。"},
            ]
            return LLMResponse(content="", tool_calls=[ToolCallRequest(f"proposal-{len(messages)}", "propose_preparation_plan", {"tasks": tasks})], finish_reason="tool_calls")
        # The real context builder can merge a cancelled user input into the next
        # user message. Its old delay marker must not delay the new test question.
        if "WAIT_FOR_CANCEL" in current and "请告诉我项目代号" not in current and not self.waited:
            self.waited = True
            await asyncio.sleep(30)
        if "DELAY_FOR_SWITCH" in current:
            await asyncio.sleep(2)
        if "先问" in current or "澄清" in current:
            answer = "工程测试回复：请问你是否实际做过用户访谈？简历没写不能认定没有经验。"
        elif "CV_C9" in current:
            answer = "工程测试回复：项目代号 CV_C9，对照岗位 JOB_B4。"
        elif "CV_A7" in current:
            answer = "工程测试回复：项目代号 CV_A7，对照岗位 JOB_B4；每周 3 天与岗位 4 天存在冲突。"
        else:
            answer = "工程测试回复：只讨论当前资料，先核对项目证据和岗位要求。"
        return LLMResponse(content=answer, finish_reason="stop")


async def run(root: Path, port: int, *, configured_model: bool = False) -> None:
    # Load through the normal runtime API; never print or persist its credentials.
    configured = load_config() if configured_model else None
    snapshot = build_provider_snapshot(configured) if configured is not None else None
    provider = snapshot.provider if snapshot is not None else EngineeringProvider()
    data = root / "instance"
    data.mkdir(parents=True, exist_ok=True)
    set_home_path(data)
    workspace = root / "workspace"
    other = root / "other-workspace"
    other.mkdir(exist_ok=True)
    config_path = data / "config.json"
    if not config_path.exists():
        config_path.write_text(json.dumps({"agents": {"defaults": {"workspace": str(workspace)}}}), encoding="utf-8")
    set_config_path(config_path)
    sessions = SessionManager(workspace, sessions_root=data / "sessions")
    seeded = sessions.read_session_metadata("websocket:ordinary") is None
    if seeded:
        seed = sessions.get_or_create("websocket:ordinary")
        seed.metadata.update({"webui": True, "title": "工程原有聊天"})
        seed.add_message("user", "工程测试：这条原有聊天需要保留。")
        seed.add_message("assistant", "工程测试：原有聊天历史仍然可读。")
        sessions.save(seed)
    write_webui_workspace_state({"favorite_projects": [str(other)]})
    config = WebSocketConfig(host="127.0.0.1", port=port)
    bus = MessageBus()
    if configured is not None and snapshot is not None:
        local = configured.model_copy(update={"agents": configured.agents.model_copy(update={
            "defaults": configured.agents.defaults.model_copy(update={"workspace": str(workspace), "unified_session": False}),
        })})
        agent = AgentLoop.from_config(local, bus, provider=provider, model=snapshot.model,
                                      session_manager=sessions, tool_registry=ToolRegistry(), hook_factories=[career_discussion_policy])
    else:
        agent = AgentLoop(bus=bus, provider=provider, workspace=workspace, model=provider.get_default_model(),
                          session_manager=sessions, tool_registry=ToolRegistry(), restrict_to_workspace=True,
                          hook_factories=[career_discussion_policy])
    gateway = build_gateway_services(
        config=config, bus=bus, session_manager=sessions,
        static_dist_path=Path(__file__).resolve().parents[1] / "nanobot/web/dist",
        workspace_path=workspace, default_restrict_to_workspace=True, config_path=config_path,
        runtime_model_name=lambda: snapshot.model if snapshot is not None else provider.get_default_model(),
        runtime_surface="browser", runtime_capabilities_overrides=None,
    )
    if seeded:
        # Browser display facts and model replay messages have separate owners.
        await sessions.state.append_history("websocket:ordinary", [
            fact_from_record({"event": "user", "chat_id": "ordinary", "text": "工程测试：这条原有聊天需要保留。"}),
            fact_from_record({"event": "message", "chat_id": "ordinary", "text": "工程测试：原有聊天历史仍然可读。"}),
        ], expected_generation=None)
    channel = WebSocketChannel(config, bus, gateway=gateway)
    agent.tools.register(ProposePreparationPlanTool(gateway.http.career, bus))
    def schedule(awaitable: Awaitable[None]) -> None:
        async def work() -> None:
            await awaitable
        agent.schedule_background(work())
    coordinator = WebuiTurnCoordinator(bus, sessions, schedule)
    unsubscribe = coordinator.subscribe()
    async def deliver() -> None:
        while True:
            message = await bus.consume_outbound()
            try:
                # Use the production dispatch primitive: streaming/reasoning have
                # their own channel methods and must not become ordinary bubbles.
                await ChannelManager._send_once(channel, message)  # pyright: ignore[reportPrivateUsage]
            finally:
                bus.outbound.task_done()
    execution = asyncio.create_task(agent.run())
    delivery = asyncio.create_task(deliver())
    serving = asyncio.create_task(channel.start())
    try:
        async with httpx.AsyncClient() as http:
            for _ in range(100):
                if serving.done():
                    await serving
                try:
                    response = await http.get(f"http://127.0.0.1:{port}/webui/bootstrap", timeout=1)
                    if response.status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.1)
            else:
                raise RuntimeError("test gateway did not start")
        print("CAREER_BROWSER_READY", flush=True)
        await asyncio.to_thread(sys.stdin.readline)
    finally:
        agent.stop()
        execution.cancel()
        with suppress(asyncio.CancelledError):
            await execution
        await agent.aclose()
        unsubscribe()
        delivery.cancel()
        with suppress(asyncio.CancelledError):
            await delivery
        await channel.stop()
        await serving
        await sessions.state.aclose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--configured-model", action="store_true")
    arguments = parser.parse_args()
    asyncio.run(run(arguments.root.resolve(), arguments.port, configured_model=arguments.configured_model))
