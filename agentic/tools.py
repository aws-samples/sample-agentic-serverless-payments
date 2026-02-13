import boto3
import base64
import json
import uuid
from strands import tool
from cost_estimator import estimate_cost
from wallet import get_wallet, get_balance, get_x402_httpx_client
import os
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from dotenv import load_dotenv

load_dotenv()

bedrock_runtime = boto3.client('bedrock-runtime', region_name=os.getenv('AWS_REGION', 'us-east-1'))

# Session-level storage - will be managed per session
# authorize_check: User consent layer before x402 automatic payment
# Enables natural language approval ("yes, proceed") with optional AgentKit spending allowances
class SessionStorage:
    def __init__(self):
        self.image_storage = {}
        self.authorize_check = {}  # User consent tracking - auth:True means user approved spend
        self.auth_verified = set()
        self.current_request_id = None  # Track current request_id
        self.current_cost = None        # Track current cost

# Global fallback for backward compatibility
IMAGE_STORAGE = {}
AUTHORIZE_CHECK = {}  # Consent gate: x402 handles payment automatically after user authorizes
AUTH_VERIFIED = set()

def get_session_storage(session_id="default"):
    """Get or create session-specific storage"""
    if not hasattr(get_session_storage, '_sessions'):
        get_session_storage._sessions = {}
    
    if session_id not in get_session_storage._sessions:
        get_session_storage._sessions[session_id] = SessionStorage()
    
    return get_session_storage._sessions[session_id]

# Seller wallet address
SELLER_WALLET = os.getenv('SELLER_WALLET')

# Force load environment before wallet initialization
load_dotenv(override=True)

# Agent wallet
AGENT_WALLET = get_wallet()

@tool
def estimate_image_cost(prompt: str, session_id: str = "default") -> str:
    """
    Estimate the cost to generate an image with Nova Canvas.
    
    Args:
        prompt: Description of the image to generate
        
    Returns:
        Cost estimate in USDC with request_id
    """
    storage = get_session_storage(session_id)
    
    # Check if there's already an active unauthorized request
    if storage.current_request_id and storage.current_request_id in storage.authorize_check:
        existing = storage.authorize_check[storage.current_request_id]
        if not existing['auth']:
            return f"Active request exists. Cost: {existing['cost']:.4f} USDC. Use make_payment() to proceed."
    
    # Nova Canvas: 1024x1024 standard = $0.04
    estimate = estimate_cost(prompt, 'nova-canvas', resolution='1024x1024', quality='standard')
    request_id = str(uuid.uuid4())
    cost_usd = estimate['totalCostUSD']
    storage.authorize_check[request_id] = {
        'prompt': prompt,
        'cost': cost_usd,
        'auth': False
    }
    # Store current request_id and cost in session
    storage.current_request_id = request_id
    storage.current_cost = cost_usd
    # Also update global for backward compatibility
    AUTHORIZE_CHECK[request_id] = storage.authorize_check[request_id]
    return f"REQUEST_ID:{request_id}|COST:{cost_usd:.4f}|USD:{cost_usd:.4f}"

@tool
def check_wallet_balance(session_id: str = "default") -> str:
    """
    Check the agent's wallet balances (ETH and USDC).
    
    Returns:
        Wallet balance information
    """
    balance_info = get_balance(AGENT_WALLET)
    if 'error' in balance_info:
        return f"Error: {balance_info['error']}"
    return f"Address: {balance_info['address']}\nNetwork: {balance_info['network']}\nETH: {balance_info['eth_balance']:.6f}\nUSDC: {balance_info['usdc_balance']:.6f}"

@tool
def make_payment(request_id: str = None, session_id: str = "default") -> str:
    """Authorize payment via natural language consent - x402 handles the actual transfer automatically.
    
    This is a user consent gate, not the actual payment. Users can approve with natural language
    (e.g., "yes, proceed") and optionally set AgentKit spending allowances for auto-approval.
    """
    storage = get_session_storage(session_id)
    
    # If no request_id provided, use current session request_id
    if request_id is None:
        request_id = storage.current_request_id
        
        # If still None, user needs to estimate cost first
        if request_id is None:
            return "Error: No active request. Please use estimate_image_cost first to get a request ID."
    
    if request_id not in storage.authorize_check:
        return "Error: Invalid request ID. Please estimate image cost first."
    
    if storage.authorize_check[request_id]['auth']:
        return "Payment already authorized"
    
    amount_usdc = storage.authorize_check[request_id]['cost']
    
    balance_info = get_balance(AGENT_WALLET)
    if balance_info['usdc_balance'] < amount_usdc:
        return f"Error: Insufficient balance. Need {amount_usdc:.6f} USDC, have {balance_info['usdc_balance']:.6f} USDC"
    
    storage.authorize_check[request_id]['auth'] = True
    storage.auth_verified.add(request_id)
    # Update global for backward compatibility
    AUTHORIZE_CHECK[request_id] = storage.authorize_check[request_id]
    AUTH_VERIFIED.add(request_id)
    
    return f"✅ Payment authorized for {amount_usdc:.4f} USDC! Ready to generate image."

@tool
def generate_image(request_id: str = None, session_id: str = "default") -> str:
    """
    Generate an image using Amazon Nova Canvas with x402 automatic payment.
    
    Args:
        request_id: The request ID from estimate_image_cost
        
    Returns:
        Success message with image ID
    """
    import asyncio
    
    storage = get_session_storage(session_id)
    
    # If no request_id provided, use current session request_id
    if request_id is None:
        request_id = storage.current_request_id
        
        # If still None, user needs to estimate cost first
        if request_id is None:
            return "Error: No active request. Please use estimate_image_cost first to get a request ID."
    
    if request_id not in storage.authorize_check:
        return "Error: Invalid request ID. Use estimate_image_cost first."
    
    prompt = storage.authorize_check[request_id]['prompt']
    cost_usdc = storage.authorize_check[request_id]['cost']
    
    # Get gateway URL from environment
    gateway_url = os.getenv('GATEWAY_URL').rstrip('/')
    print(f"Using gateway URL: {gateway_url}")
    
    # Check if payment was authorized - if not, return authorization required
    if not storage.authorize_check[request_id].get('auth'):
        return f"AUTHORIZE_CHECK - Cost: {cost_usdc:.4f} USDC. Payment authorization needed before image generation."
    
    # Use x402 httpx client - it handles 402 and payment automatically
    async def make_request():
        async with get_x402_httpx_client(AGENT_WALLET, gateway_url) as client:
            print(f"\n=== X402 REQUEST ===")
            print(f"Gateway: {gateway_url}/generate_image")
            print(f"Request ID: {request_id}")
            print(f"Cost: {cost_usdc} USDC")
            
            # Convert USDC to wei for x402 protocol
            cost_wei = int(cost_usdc * 1e6)
            response = await client.post(
                "/generate_image",
                json={'request_id': request_id, 'prompt': prompt, 'price': str(cost_wei)},
                timeout=30
            )
            
            print(f"Response status: {response.status_code}")
            print(f"Response body: {response.text[:500]}")
            return response
    
    try:
        response = asyncio.run(make_request())
        
        if response.status_code != 200:
            return f"Error: Gateway returned {response.status_code}. Response: {response.text[:200]}"
        
        # Extract nonce for deferred settlement
        response_data = response.json()
        payment_nonce = response_data.get('nonce')
            
    except Exception as e:
        import traceback
        print(f"x402 error: {str(e)}")
        print(traceback.format_exc())
        return f"Error: {str(e)}"
    
    # Generate image with Bedrock
    request_body = {
        "taskType": "TEXT_IMAGE",
        "textToImageParams": {
            "text": prompt
        },
        "imageGenerationConfig": {
            "numberOfImages": 1,
            "quality": "standard",
            "height": 1024,
            "width": 1024
        }
    }
    
    bedrock_response = bedrock_runtime.invoke_model(
        modelId="amazon.nova-canvas-v1:0",
        body=json.dumps(request_body)
    )
    
    response_body = json.loads(bedrock_response['body'].read())
    image_base64 = response_body['images'][0]
    
    # x402 spec: settle after content delivery (fair billing - only charge on success)
    transaction_hash = None
    if payment_nonce:
        try:
            settle_response = requests.post(
                f"{gateway_url}/settle",
                json={'nonce': payment_nonce},
                timeout=30
            )
            if settle_response.status_code == 200:
                settle_data = settle_response.json()
                transaction_hash = settle_data.get('transaction_hash')
                print(f"Payment settled: {transaction_hash}")
            else:
                print(f"Settlement returned {settle_response.status_code} (testnet expected)")
        except Exception as e:
            print(f"Settlement error (testnet expected): {e}")
    
    # Store image with unique ID (don't return base64 to agent)
    image_id = str(uuid.uuid4())
    image_data = f"data:image/png;base64,{image_base64}"
    storage.image_storage[image_id] = image_data
    # Update global for backward compatibility
    IMAGE_STORAGE[image_id] = image_data
    
    # Store image_id for potential analysis
    storage.authorize_check[request_id]['image_id'] = image_id
    AUTHORIZE_CHECK[request_id] = storage.authorize_check[request_id]
    
    # Clear current request_id after successful completion to allow new requests
    storage.current_request_id = None
    storage.current_cost = None
    
    # Build success message with transaction info
    success_msg = f"SUCCESS|IMAGE_ID:{image_id}\n\nImage generated successfully! Payment verified on base-sepolia.\nImage ID: {image_id}"
    if transaction_hash:
        success_msg += f"\nTransaction: {transaction_hash}\nExplorer: https://sepolia.basescan.org/tx/{transaction_hash}"
    
    return success_msg


@tool
def analyze_content_monetization(image_id: str, analysis_type: str = "monetization", session_id: str = "default") -> str:
    """
    Analyze image using Claude Sonnet 4 with vision. ONLY use when user EXPLICITLY requests analysis, description, poem, or other image analysis.
    DO NOT use automatically after image generation unless specifically asked.
    
    Args:
        image_id: The ID of the generated image to analyze (format: IMAGE_ID:uuid)
        analysis_type: Type of analysis (monetization, description, poem, etc.)
        
    Returns:
        Analysis based on requested type
    """
    # Extract UUID from IMAGE_ID:uuid format
    if image_id.startswith("IMAGE_ID:"):
        uuid_part = image_id.replace("IMAGE_ID:", "")
    else:
        uuid_part = image_id
    
    # Get image from session storage first, fallback to global
    storage = get_session_storage(session_id)
    if uuid_part in storage.image_storage:
        image_data = storage.image_storage[uuid_part]
    elif uuid_part in IMAGE_STORAGE:
        image_data = IMAGE_STORAGE[uuid_part]
    else:
        return "Error: Image not found. Please generate an image first."
    image_base64 = image_data.replace("data:image/png;base64,", "")
    request_body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 2000,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": image_base64
                        }
                    },
                    {
                        "type": "text",
                        "text": f"Analyze this AI-generated image for: {analysis_type}. If monetization: provide viability (1-10), market value, licensing opportunities, legal considerations, optimization tips, platforms, and SEO keywords. Otherwise, provide the requested analysis."
                    }
                ]
            }
        ]
    }
    
    response = bedrock_runtime.invoke_model(
        modelId="us.anthropic.claude-sonnet-4-20250514-v1:0",
        body=json.dumps(request_body)
    )
    
    response_body = json.loads(response['body'].read())
    return response_body['content'][0]['text']
