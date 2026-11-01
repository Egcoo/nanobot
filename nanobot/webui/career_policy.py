"""Server-side discussion-only policy for the fourth career-workbench stage."""

from nanobot.agent.hook import AgentHook, AgentHookContext, AgentTurnHookContext
from nanobot.providers.base import ToolCallRequest
from nanobot.webui.career_turns import CAREER_TURN_METADATA


class CareerDiscussionPolicy(AgentHook):
    def __init__(self) -> None:
        super().__init__(reraise=True)

    async def before_execute_tool(
        self, context: AgentHookContext, tool_call: ToolCallRequest, tool: object, params: object,
    ) -> None:
        raise PermissionError("Career discussion does not authorize tool execution. No action was performed.")


def career_discussion_policy(context: AgentTurnHookContext) -> AgentHook | None:
    if context.channel == "websocket" and isinstance(context.metadata.get(CAREER_TURN_METADATA), dict):
        return CareerDiscussionPolicy()
    return None
