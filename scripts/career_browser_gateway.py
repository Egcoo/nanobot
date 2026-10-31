"""Local browser-test gateway using synthetic data, with no agent or model calls.

Run only with a disposable --root. stdin 'stop' closes the listener and sessions;
restarting with the same root verifies actual process restart recovery.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

import httpx

from nanobot.bus.queue import MessageBus
from nanobot.channels.websocket.runtime import WebSocketChannel, WebSocketConfig
from nanobot.config.loader import set_config_path
from nanobot.session.manager import SessionManager
from nanobot.webui.gateway_services import build_gateway_services
from nanobot.webui.history import fact_from_record
from nanobot.webui.workspaces import write_webui_workspace_state


async def run(root: Path, port: int) -> None:
    data = root / "instance"
    data.mkdir(parents=True, exist_ok=True)
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
    gateway = build_gateway_services(
        config=config, bus=bus, session_manager=sessions,
        static_dist_path=Path(__file__).resolve().parents[1] / "nanobot/web/dist",
        workspace_path=workspace, default_restrict_to_workspace=True, config_path=config_path,
        runtime_model_name=lambda: None, runtime_surface="browser", runtime_capabilities_overrides=None,
    )
    if seeded:
        # Browser display facts and model replay messages have separate owners.
        await sessions.state.append_history("websocket:ordinary", [
            fact_from_record({"event": "user", "chat_id": "ordinary", "text": "工程测试：这条原有聊天需要保留。"}),
            fact_from_record({"event": "message", "chat_id": "ordinary", "text": "工程测试：原有聊天历史仍然可读。"}),
        ], expected_generation=None)
    channel = WebSocketChannel(config, bus, gateway=gateway)
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
        await channel.stop()
        await serving
        await sessions.state.aclose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    arguments = parser.parse_args()
    asyncio.run(run(arguments.root.resolve(), arguments.port))
