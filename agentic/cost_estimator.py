import requests

# Nova Canvas fixed per-image pricing
NOVA_CANVAS_PRICING = {
    '1024x1024': {'standard': 0.04, 'premium': 0.06},
    '2048x2048': {'standard': 0.06, 'premium': 0.08}
}

def get_usdc_price() -> float:
    """Fetch USDC price from CoinGecko (should be ~$1.00)"""
    try:
        response = requests.get('https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=usd', timeout=5)
        return response.json()['usd-coin']['usd']
    except:
        return 1.0

def estimate_cost(content: str, model: str = 'nova-canvas', resolution: str = '1024x1024', quality: str = 'standard') -> dict:
    """Estimate cost for Nova Canvas image generation (fixed per-image pricing)"""
    # Nova Canvas uses fixed pricing per image, not token-based
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
