from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from nanobot.agent.loop import AgentLoop
from nanobot.agent.tools.base import Tool
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.bus.events import InboundMessage
from nanobot.bus.queue import MessageBus
from nanobot.providers.base import LLMResponse, ToolCallRequest
from nanobot.session.manager import SessionManager
from nanobot.webui.career_policy import career_discussion_policy
from nanobot.webui.career_turns import CAREER_TURN_METADATA
from scripts.career_browser_gateway import EngineeringProvider


@pytest.mark.parametrize("career", [False, True], ids=["ordinary-tools-retained", "career-actions-blocked"])
async def test_tool_policy_blocks_a_real_write_only_for_career_turns(tmp_path: Path, monkeypatch, career):
    monkeypatch.setattr("nanobot.config.home._home_path", tmp_path / "instance")
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    marker = workspace / "tool-side-effect.txt"

    class WriteTool(Tool):
        name = "write_marker"
        description = "Write a marker in the disposable test workspace."
        parameters = {"type": "object", "properties": {}}

        async def execute(self, **kwargs):
            marker.write_text("changed", encoding="utf-8")
            return "written"

    class Provider(EngineeringProvider):
        def __init__(self):
            super().__init__()
            self.calls = 0

        async def chat(self, messages, **kwargs):
            self.calls += 1
            if self.calls == 1:
                return LLMResponse(content="", tool_calls=[ToolCallRequest("call", "write_marker", {})], finish_reason="tool_calls")
            return LLMResponse(content="工程测试完成", finish_reason="stop")

    tools = ToolRegistry()
    tools.register(WriteTool())
    sessions = SessionManager(workspace, sessions_root=tmp_path / "instance" / "sessions")
    loop = AgentLoop(MessageBus(), Provider(), workspace, session_manager=sessions, tool_registry=tools,
                     hook_factories=[career_discussion_policy], max_iterations=3)
    message = InboundMessage(channel="websocket", sender_id="engineering", chat_id="policy", content="工程测试工具请求",
                             metadata={CAREER_TURN_METADATA: {"analysis_id": "test"}} if career else {})
    try:
        await loop._enqueue_session_message(message)
        await asyncio.gather(*tuple(loop._active_tasks[loop._effective_session_key(message)]))
        assert marker.exists() is (not career)
    finally:
        await loop.aclose()
        await sessions.state.aclose()
