import os
from web3 import Web3
from dotenv import load_dotenv

load_dotenv()

# Base Sepolia RPC
RPC_URL = os.getenv('RPC_URL')

# Global Web3 instance
_web3 = None

def get_web3():
    """Get or create Web3 instance"""
    global _web3
    if _web3 is None:
        _web3 = Web3(Web3.HTTPProvider(RPC_URL))
    return _web3
