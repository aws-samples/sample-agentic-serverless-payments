import os
import logging
from coinbase_agentkit import (
    AgentKit,
    AgentKitConfig,
    CdpEvmWalletProvider,
    CdpEvmWalletProviderConfig,
)
from web3_provider import get_web3
from web3 import Web3
from x402.clients.httpx import x402HttpxClient
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# USDC contract address from environment
USDC_CONTRACT = os.getenv('USDC_CONTRACT')

# ERC-20 ABI
ERC20_ABI = [
    {
        "constant": True,
        "inputs": [{"name": "_owner", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"name": "balance", "type": "uint256"}],
        "type": "function"
    },
    {
        "constant": False,
        "inputs": [
            {"name": "_to", "type": "address"},
            {"name": "_value", "type": "uint256"}
        ],
        "name": "transfer",
        "outputs": [{"name": "", "type": "bool"}],
        "type": "function"
    }
]

class _SignedMessageAdapter:
    """Minimal adapter for x402's expected signed message shape."""

    def __init__(self, signature_hex: str):
        if not isinstance(signature_hex, str):
            raise ValueError("Expected hex string signature from CDP wallet signer")

        normalized = signature_hex[2:] if signature_hex.startswith("0x") else signature_hex
        self.signature = bytes.fromhex(normalized)


def _normalize_typed_data_values(value):
    """Convert bytes values to 0x-prefixed hex for CDP typed-data signing."""
    if isinstance(value, (bytes, bytearray)):
        return "0x" + bytes(value).hex()
    if isinstance(value, dict):
        return {k: _normalize_typed_data_values(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_normalize_typed_data_values(v) for v in value]
    return value


class _CdpWalletAccountAdapter:
    """Adapter so legacy x402 client can sign via CDP without key export."""

    def __init__(self, wallet):
        if not hasattr(wallet, "sign_typed_data"):
            raise ValueError("Wallet does not support sign_typed_data required by x402")
        self._wallet = wallet
        self.address = wallet.get_address()

    def sign_typed_data(self, domain_data, message_types, message_data):
        primary_types = [name for name in message_types if name != "EIP712Domain"]
        if len(primary_types) != 1:
            raise ValueError(
                f"Unable to determine EIP-712 primary type from message types: {list(message_types.keys())}"
            )

        typed_data = {
            "domain": domain_data,
            "types": message_types,
            "primaryType": primary_types[0],
            "message": _normalize_typed_data_values(message_data),
        }

        signature = self._wallet.sign_typed_data(typed_data)
        return _SignedMessageAdapter(signature)


def get_x402_httpx_client(wallet, base_url: str):
    """Create x402 HTTP client using CDP-managed signing (no key export)."""
    from x402.clients.base import x402Client

    try:
        account = _CdpWalletAccountAdapter(wallet)
        logger.info('Using CDP wallet signer for x402 (private key remains in CDP)')
    except Exception as e:
        logger.error(f'Failed to configure CDP wallet signer: {e}')
        raise ValueError(f'Failed to configure CDP wallet signing for x402: {e}') from e
    
    def payment_selector(accepts, network_filter=None, scheme_filter=None, max_value=None):
        return x402Client.default_payment_requirements_selector(
            accepts,
            network_filter=os.getenv('NETWORK_ID', 'base-sepolia'),
            scheme_filter=scheme_filter,
            max_value=max_value
        )
    
    return x402HttpxClient(
        account=account,
        base_url=base_url,
        payment_requirements_selector=payment_selector
    )

_agentkit = None

def get_agentkit():
    """Get or create AgentKit instance"""
    global _agentkit
    if _agentkit is None:
        wallet_provider = CdpEvmWalletProvider(
            CdpEvmWalletProviderConfig(
                api_key_id=os.getenv('CDP_API_KEY_ID'),
                api_key_secret=os.getenv('CDP_API_KEY_SECRET'),
                wallet_secret=os.getenv('CDP_WALLET_SECRET'),
                network_id=os.getenv('NETWORK_ID'),
                # Shared idempotency key is safe - wallet uniqueness comes from CDP_API_KEY + CDP_WALLET_SECRET
                # You can generate your own with: python -c "import uuid; print(uuid.uuid4())"
                idempotency_key='550e8400-e29b-41d4-a716-446655440000',
            )
        )
        _agentkit = AgentKit(
            AgentKitConfig(
                wallet_provider=wallet_provider,
                action_providers=[],
            )
        )
        print(f"Wallet initialized: {_agentkit.wallet_provider.get_address()}")
    return _agentkit

def get_wallet():
    """Get wallet from AgentKit"""
    agentkit = get_agentkit()
    return agentkit.wallet_provider

def get_eth_balance(wallet) -> float:
    """Get native ETH balance using Web3"""
    try:
        w3 = get_web3()
        wallet_address = wallet.get_address()
        balance_wei = w3.eth.get_balance(wallet_address)
        return balance_wei / 1e18
    except Exception as e:
        logger.error(f"Error getting ETH balance: {str(e)}")
        return 0.0

def get_usdc_balance(address: str) -> float:
    """Get USDC balance using Web3"""
    try:
        w3 = get_web3()
        contract = w3.eth.contract(address=USDC_CONTRACT, abi=ERC20_ABI)
        balance_wei = contract.functions.balanceOf(address).call()
        return balance_wei / 1e6
    except Exception as e:
        logger.error(f"Error getting USDC balance: {str(e)}")
        return 0.0

def get_balance(wallet) -> dict:
    """Get native ETH and USDC balances"""
    try:
        wallet_address = wallet.get_address()
        network = wallet.get_network()
        
        # Get native ETH balance using AgentKit
        eth_balance = get_eth_balance(wallet)
        
        # Get USDC balance using Web3
        usdc_balance = get_usdc_balance(wallet_address)
        
        logger.info(f"Balances - ETH: {eth_balance}, USDC: {usdc_balance}")
        
        return {
            'eth_balance': eth_balance,
            'usdc_balance': usdc_balance,
            'balance': usdc_balance,  # Keep for backward compatibility
            'address': wallet_address,
            'network': network,
            'asset': 'USDC'
        }
            
    except Exception as e:
        logger.error(f"Error getting balances: {str(e)}")
        return {'error': str(e), 'balance': 0.0, 'eth_balance': 0.0, 'usdc_balance': 0.0}



def native_transfer(wallet, to_address: str, amount_wei: int) -> dict:
    """Native USDC transfer (reference only - not used in x402 flow)"""
    try:
        amount_usdc = amount_wei / 1e6
        logger.info(f"Transferring {amount_usdc} USDC to {to_address}")
        
        w3 = get_web3()
        contract = w3.eth.contract(address=USDC_CONTRACT, abi=ERC20_ABI)
        wallet_address = wallet.get_address()
        
        tx = contract.functions.transfer(to_address, amount_wei).build_transaction({
            'from': wallet_address,
            'nonce': w3.eth.get_transaction_count(wallet_address),
            'gas': 100000,
            'gasPrice': w3.eth.gas_price,
        })
        
        signed_tx = wallet.sign_transaction(tx)
        tx_hash = w3.eth.send_raw_transaction(signed_tx['rawTransaction'])
        
        logger.info(f"USDC transfer successful: {tx_hash.hex()}")
        
        return {
            'status': 'success',
            'transaction_hash': tx_hash.hex(),
            'amount_wei': amount_wei,
            'amount_usdc': amount_usdc,
            'to': to_address
        }
    except Exception as e:
        logger.error(f"USDC transfer failed: {str(e)}")
        return {'status': 'error', 'error': str(e)}
