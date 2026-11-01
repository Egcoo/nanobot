"""Bound career turns may execute only the validated plan-draft proposal tool."""

from nanobot.agent.hook import AgentHook, AgentHookContext, AgentTurnHookContext
from nanobot.providers.base import ToolCallRequest
from nanobot.webui.career_tools import ProposePreparationPlanTool
from nanobot.webui.career_turns import CAREER_TURN_METADATA


class CareerDiscussionPolicy(AgentHook):
    def __init__(self) -> None:
        super().__init__(reraise=True)

    async def before_execute_tool(
        self, context: AgentHookContext, tool_call: ToolCallRequest, tool: object, params: object,
    ) -> None:
        if isinstance(tool, ProposePreparationPlanTool):
            return
        raise PermissionError("Career preparation permits only plan-draft proposals. This tool was not executed.")


def career_discussion_policy(context: AgentTurnHookContext) -> AgentHook | None:
    if context.channel == "websocket" and isinstance(context.metadata.get(CAREER_TURN_METADATA), dict):
        return CareerDiscussionPolicy()
    return None
