import os
import logging
from strands.hooks import HookProvider, HookRegistry, BeforeInvocationEvent, AfterInvocationEvent, BeforeToolCallEvent, AfterToolCallEvent, BeforeModelCallEvent, AfterModelCallEvent
from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

MEMORY_ID = os.getenv("BEDROCK_AGENTCORE_MEMORY_ID")
REGION = os.getenv("AWS_REGION", "us-east-1")

# Configure logging for CloudWatch
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class MemoryHook(HookProvider):
    def __init__(self):
        self.session_manager = None
    
    def register_hooks(self, registry: HookRegistry) -> None:
        if MEMORY_ID:
            registry.add_callback(BeforeInvocationEvent, self.setup_memory)
        
        # Add observability hooks
        registry.add_callback(BeforeInvocationEvent, self.log_invocation_start)
        registry.add_callback(AfterInvocationEvent, self.log_invocation_end)
        registry.add_callback(BeforeToolCallEvent, self.log_tool_call_start)
        registry.add_callback(AfterToolCallEvent, self.log_tool_call_end)
        registry.add_callback(BeforeModelCallEvent, self.log_model_call_start)
        registry.add_callback(AfterModelCallEvent, self.log_model_call_end)
    
    def setup_memory(self, event: BeforeInvocationEvent) -> None:
        if MEMORY_ID and not hasattr(event.agent, 'session_manager'):
            session_id = getattr(event.agent.state, "session_id", "default")
            memory_config = AgentCoreMemoryConfig(
                memory_id=MEMORY_ID,
                session_id=session_id,
                actor_id="user"
            )
            session_manager = AgentCoreMemorySessionManager(
                agentcore_memory_config=memory_config,
                region_name=REGION
            )
            event.agent.session_manager = session_manager
    
    def log_invocation_start(self, event: BeforeInvocationEvent) -> None:
        session_id = getattr(event.agent.state, "session_id", "default")
        logger.info(f"[INVOCATION_START] Session: {session_id}, Agent: {event.agent.__class__.__name__}")
    
    def log_invocation_end(self, event: AfterInvocationEvent) -> None:
        session_id = getattr(event.agent.state, "session_id", "default")
        logger.info(f"[INVOCATION_END] Session: {session_id}, Success: {not hasattr(event, 'error')}")
    
    def log_tool_call_start(self, event: BeforeToolCallEvent) -> None:
        tool_name = event.tool_use.get('name', 'unknown')
        tool_input = event.tool_use.get('input', {})
        logger.info(f"[TOOL_CALL_START] Tool: {tool_name}, Input: {tool_input}")
    
    def log_tool_call_end(self, event: AfterToolCallEvent) -> None:
        tool_name = event.tool_use.get('name', 'unknown')
        result_preview = str(event.result)[:200] if event.result else "None"
        logger.info(f"[TOOL_CALL_END] Tool: {tool_name}, Result: {result_preview}...")
    
    def log_model_call_start(self, event: BeforeModelCallEvent) -> None:
        logger.info("[MODEL_CALL_START]")
    
    def log_model_call_end(self, event: AfterModelCallEvent) -> None:
        success = event.exception is None
        logger.info(f"[MODEL_CALL_END] Success: {success}")