"""Unit tests for the payment agent's in-process x402 fallback (_pay_and_retry).

Run from the repository root (needs only `requests` and `boto3`):

    pip install requests boto3
    python -m unittest discover -s test/unit -v

The real payment-agent/tools.py is imported; HTTP, ProcessPayment and sleeps are
faked. `strands` is stubbed because only its @tool decorator is used at import.
"""
import base64
import json
import os
import sys
import types
import unittest
from unittest import mock

import requests

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "payment-agent"))
sys.modules.setdefault("strands", types.SimpleNamespace(tool=lambda fn: fn))
os.environ.setdefault("STOREFRONT_API_URL", "https://storefront.example")
os.environ.setdefault("SELLER_API_URL", "https://seller.example")

import tools  # noqa: E402

ACCEPT = {
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "40000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x1111111111111111111111111111111111111111",
    "maxTimeoutSeconds": 300,
    "extra": {"name": "USDC", "version": "2"},
}


class FakeResponse:
    def __init__(self, status_code, body=None, headers=None):
        self.status_code = status_code
        self._body = body if body is not None else {}
        self.headers = headers or {}
        self.text = json.dumps(self._body)

    def json(self):
        return self._body


def payment_required():
    header = base64.b64encode(json.dumps({"x402Version": 2, "accepts": [ACCEPT]}).encode()).decode()
    return FakeResponse(402, {}, {"payment-required": header})


class PayAndRetryTest(unittest.TestCase):
    def setUp(self):
        tools.set_plugin_active(False)  # voice mode: the in-process fallback pays
        tools.set_payment_credentials(
            payment_manager_arn="arn:aws:bedrock-agentcore:us-east-1:123456789012:payment-manager/pm",
            instrument_id="inst-1",
            session_id="sess-1",
            user_id="user-1",
        )
        self.sent = []  # headers of every HTTP request, in order
        self.responses = []

        def post(url, json=None, data=None, headers=None, timeout=None):
            self.sent.append(dict(headers or {}))
            nxt = self.responses.pop(0)
            if isinstance(nxt, Exception):
                raise nxt
            return nxt

        session = mock.Mock()
        session.post.side_effect = post
        patches = [
            mock.patch.object(tools._requests, "Session", return_value=session),
            mock.patch.object(tools._time, "sleep"),
            mock.patch.object(tools, "_process_payment", return_value={
                "status": "PROOF_GENERATED",
                "paymentOutput": {"cryptoX402": {"version": "2", "payload": {"signature": "0xsig"}}},
            }),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def signed_attempts(self):
        return [h for h in self.sent if "X-PAYMENT" in h]

    # ── Outcomes that leave a signed payment's fate unknown ──

    def test_402_on_every_signed_attempt_raises_not_confirmed(self):
        self.responses = [payment_required()] + [FakeResponse(402, {"error": "settlement failed"})] * 5

        with self.assertRaises(tools.PaymentNotConfirmed) as ctx:
            tools._pay_and_retry("https://storefront.example/orders", body={"productId": "p1"})

        err = ctx.exception
        self.assertEqual(err.attempts, 5)
        self.assertEqual(err.last_status, 402)
        self.assertEqual(err.network, "eip155:84532")
        self.assertEqual(err.amount, "40000")
        self.assertEqual(tools._process_payment.call_count, 1, "exactly one payment is signed")
        signatures = {h["X-PAYMENT"] for h in self.signed_attempts()}
        self.assertEqual(len(signatures), 1, "every retry re-presents the same proof")

    def test_server_error_after_payment_raises_not_confirmed(self):
        self.responses = [payment_required(), FakeResponse(504, {"message": "Endpoint request timed out"})]

        with self.assertRaises(tools.PaymentNotConfirmed) as ctx:
            tools._pay_and_retry("https://storefront.example/orders", body={})

        self.assertEqual(ctx.exception.last_status, 504)
        self.assertEqual(ctx.exception.attempts, 1)

    def test_connection_error_after_payment_raises_not_confirmed(self):
        self.responses = [payment_required(), requests.ReadTimeout("read timed out")]

        with self.assertRaises(tools.PaymentNotConfirmed) as ctx:
            tools._pay_and_retry("https://storefront.example/orders", body={})

        self.assertIsNone(ctx.exception.last_status)
        self.assertEqual(ctx.exception.detail, "ReadTimeout")
        self.assertIsInstance(ctx.exception.__cause__, requests.ReadTimeout)

    # ── Outcomes whose meaning is unchanged ──

    def test_success_after_a_settling_402_returns_the_response(self):
        self.responses = [payment_required(), FakeResponse(402), FakeResponse(201, {"order": {"orderId": "order-1"}})]

        resp = tools._pay_and_retry("https://storefront.example/orders", body={})

        self.assertEqual(resp.status_code, 201)
        self.assertEqual(len(self.signed_attempts()), 2)

    def test_client_error_after_payment_is_returned_as_is(self):
        # A 4xx other than 402 means the seller rejected the request itself.
        self.responses = [payment_required(), FakeResponse(409, {"error": "Out of stock"})]

        resp = tools._pay_and_retry("https://storefront.example/orders", body={})

        self.assertEqual(resp.status_code, 409)

    def test_free_endpoint_never_pays(self):
        self.responses = [FakeResponse(200, {"ok": True})]

        resp = tools._pay_and_retry("https://storefront.example/orders", body={})

        self.assertEqual(resp.status_code, 200)
        tools._process_payment.assert_not_called()

    def test_failure_before_signing_is_not_reported_as_unconfirmed(self):
        self.responses = [FakeResponse(402, {})]  # no requirements in header or body

        with self.assertRaises(RuntimeError) as ctx:
            tools._pay_and_retry("https://storefront.example/orders", body={})

        self.assertNotIsInstance(ctx.exception, tools.PaymentNotConfirmed)
        tools._process_payment.assert_not_called()

    # ── What the model sees ──

    def assert_unconfirmed_result(self, raw):
        self.assertFalse(raw.startswith("PAYMENT_REQUIRED"), "must not ask the payment layer to pay again")
        result = json.loads(raw)
        self.assertEqual(result["paymentStatus"], "unconfirmed")
        self.assertTrue(result["paymentAttempted"])
        self.assertIn("Do not retry", result["guidance"])
        self.assertNotIn("Payment failed", result["error"])

    def test_buy_product_reports_an_unconfirmed_payment(self):
        self.responses = [payment_required()] + [FakeResponse(402, {"error": "settlement failed"})] * 5

        raw = tools.strands_buy_product("p1")

        self.assert_unconfirmed_result(raw)
        self.assertEqual(json.loads(raw)["sellerResponse"], json.dumps({"error": "settlement failed"}))
        self.assertEqual(tools._process_payment.call_count, 1)

    def test_generate_image_reports_an_unconfirmed_payment(self):
        self.responses = [payment_required(), requests.ConnectionError("reset")]

        self.assert_unconfirmed_result(tools.strands_generate_image("a lighthouse at dusk"))

    def test_buy_product_out_of_stock_message_is_unchanged(self):
        self.responses = [payment_required(), FakeResponse(409, {"error": "Out of stock"})]

        result = json.loads(tools.strands_buy_product("p1"))

        self.assertTrue(result["error"].startswith("Out of stock or conflict"))


if __name__ == "__main__":
    unittest.main()
