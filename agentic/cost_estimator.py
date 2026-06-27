import time
import threading
import requests

NOVA_CANVAS_PRICING = {
    '1024x1024': {'standard': 0.04, 'premium': 0.06},
    '2048x2048': {'standard': 0.06, 'premium': 0.08}
}

_price_cache: dict = {'price': 1.0, 'expires_at': 0.0}
_price_lock = threading.Lock()
_PRICE_TTL = 60


def get_usdc_price() -> float:
    """Fetch USDC price from CoinGecko, cached for 60 seconds."""
    now = time.monotonic()
    with _price_lock:
        if now < _price_cache['expires_at']:
            return _price_cache['price']

    try:
        response = requests.get(
            'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd',
            timeout=5
        )
        price = float(response.json()['usd-coin']['usd'])
    except Exception:
        price = 1.0

    with _price_lock:
        _price_cache['price'] = price
        _price_cache['expires_at'] = time.monotonic() + _PRICE_TTL

    return price


def estimate_cost(content: str, model: str = 'nova-canvas', resolution: str = '1024x1024', quality: str = 'standard') -> dict:
    """Estimate cost for Nova Canvas image generation (fixed per-image pricing)"""
    total_cost_usd = NOVA_CANVAS_PRICING[resolution][quality]
    usdc_price = get_usdc_price()
    total_cost_usdc = total_cost_usd / usdc_price
    total_cost_usdc_wei = int(total_cost_usdc * 1_000_000)
    return {
        'model': model,
        'resolution': resolution,
        'quality': quality,
        'totalCost': total_cost_usdc_wei,
        'totalCostUSD': total_cost_usd,
        'usdcPrice': usdc_price
    }
