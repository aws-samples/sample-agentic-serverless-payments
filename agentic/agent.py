from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Dict, Any, Optional
from datetime import datetime, timezone
from strands import Agent
from strands.models import BedrockModel
from tools import estimate_image_cost, check_wallet_balance, make_payment, generate_image, analyze_content_monetization, IMAGE_STORAGE
from memory_hook import MemoryHook, MEMORY_ID
import os
import logging

# Configure logging
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Content Monetization Agent", version="1.0.0")

model = BedrockModel(
    model_id="us.anthropic.claude-sonnet-4-20250514-v1:0",
    temperature=0.7,
    streaming=False  # Use Converse API for reliability
)

agent = Agent(
    model=model,
    system_prompt="""You are a helpful AI assistant that can generate and analyze images.

For wallet queries: Use check_wallet_balance(session_id)
For image generation: Follow x402 payment flow with session_id parameter

x402 Payment Flow (FOLLOW EXACTLY):
1. estimate_image_cost(prompt, session_id) → get REQUEST_ID and COST
2. generate_image(session_id=session_id) → returns PAYMENT_REQUIRED
3. make_payment(session_id=session_id) → marks payment as authorized
4. generate_image(session_id=session_id) AGAIN → x402 handles payment → returns SUCCESS

CRITICAL:
- ALWAYS use the CURRENT session_id (NOT 'default') in ALL tool calls
- NEVER re-estimate cost if request_id already exists in session
- ALWAYS call generate_image FIRST (step 2) to get PAYMENT_REQUIRED
- ALWAYS call generate_image AGAIN after make_payment (step 4)
- Follow the exact sequence: estimate → generate → make_payment → generate
- If user asks about wallet, call check_wallet_balance immediately""",
    tools=[estimate_image_cost, check_wallet_balance, make_payment, generate_image, analyze_content_monetization],
    hooks=[MemoryHook()],
    state={"session_id": "default"}
)

class InvocationRequest(BaseModel):
    input: Dict[str, Any]
    session_id: Optional[str] = None

class InvocationResponse(BaseModel):
    output: Dict[str, Any]

@app.post("/invocations", response_model=InvocationResponse)
async def invoke_agent(request: InvocationRequest):
    import logging
    logger = logging.getLogger(__name__)
    
    try:
        logger.info(f"📥 [REQUEST] Session:{request.session_id} | Prompt:{request.input.get('prompt', '')[:100]}")
        
        user_message = request.input.get("prompt", "")
        if not user_message:
            raise HTTPException(
                status_code=400,
                detail="No prompt found in input. Please provide a 'prompt' key."
            )
        
        # Set session ID for memory isolation
        session_id = request.session_id or request.input.get("session_id", "default")
        agent.state.session_id = session_id
        
        logger.info(f"🤖 [AGENT_START] Session:{session_id} | Message:{user_message[:100]}")
        result = agent(user_message)
        logger.info(f"💬 [AGENT_RESPONSE] Session:{session_id} | Response:{str(result.message)[:300]}...")
        
        # Extract images from global storage (images are returned to user)
        images = {}
        for image_id, image_data in IMAGE_STORAGE.items():
            images[image_id] = image_data
        
        # Clear storage after extraction
        IMAGE_STORAGE.clear()
        
        response = {
            "message": result.message,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "model": "claude-sonnet-4.5",
            "session_id": session_id,
            "images": images
        }

        return InvocationResponse(output=response)

    except Exception as e:
        logger.error(f"Agent error: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Agent error: {str(e)}")

@app.get("/ping")
async def ping():
    return {"status": "healthy"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
