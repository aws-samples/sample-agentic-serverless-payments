"""Unit tests for how the payment agent reports a signed x402 payment.

Covers the in-process fallback used in voice mode (_pay_and_retry) and the
plugin path used in text and REST modes (_paid_request re-invoked with a
signed header).

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


def signed_header(accept=ACCEPT):
    """A PAYMENT-SIGNATURE header like the one the plugin injects on re-invocation."""
    payload = {"x402Version": 2, "accepted": accept, "payload": {"signature": "0xsig"}}
    return {"PAYMENT-SIGNATURE": base64.b64encode(json.dumps(payload).encode()).decode()}


class PluginPathTest(unittest.TestCase):
    """Text and REST modes: the AgentCorePaymentsPlugin signs, then re-invokes the
    tool with a signed header. The tool sends it once; this checks how the
    outcome of that signed request is reported."""

    def setUp(self):
        tools.set_plugin_active(True)
        self.addCleanup(tools.set_plugin_active, False)
        self.sent = []
        self.responses = []

        def post(url, json=None, data=None, headers=None, timeout=None):
            self.sent.append(dict(headers or {}))
            nxt = self.responses.pop(0)
            if isinstance(nxt, Exception):
                raise nxt
            return nxt

        session = mock.Mock()
        session.post.side_effect = post
        p = mock.patch.object(tools._requests, "Session", return_value=session)
        p.start()
        self.addCleanup(p.stop)

    # ── Outcomes that leave a signed payment's fate unknown ──

    def test_402_to_a_signed_request_raises_not_confirmed(self):
        self.responses = [FakeResponse(402, {"error": "settlement failed"})]

        with self.assertRaises(tools.PaymentNotConfirmed) as ctx:
            tools._paid_request("https://storefront.example/orders", body={}, headers=signed_header())

        err = ctx.exception
        self.assertEqual((err.attempts, err.last_status), (1, 402))
        self.assertEqual((err.network, err.amount), ("eip155:84532", "40000"))

    def test_server_error_to_a_signed_request_raises_not_confirmed(self):
        self.responses = [FakeResponse(504, {"message": "Endpoint request timed out"})]

        with self.assertRaises(tools.PaymentNotConfirmed) as ctx:
            tools._paid_request("https://storefront.example/orders", body={}, headers=signed_header())

        self.assertEqual(ctx.exception.last_status, 504)

    def test_connection_error_on_a_signed_request_raises_not_confirmed(self):
        self.responses = [requests.ReadTimeout("read timed out")]

        with self.assertRaises(tools.PaymentNotConfirmed) as ctx:
            tools._paid_request("https://storefront.example/orders", body={}, headers=signed_header())

        self.assertIsNone(ctx.exception.last_status)
        self.assertIsInstance(ctx.exception.__cause__, requests.ReadTimeout)

    def test_unreadable_signed_header_still_reports_unconfirmed(self):
        self.responses = [FakeResponse(402)]

        with self.assertRaises(tools.PaymentNotConfirmed) as ctx:
            tools._paid_request("https://storefront.example/orders", body={}, headers={"PAYMENT-SIGNATURE": "not base64 json"})

        self.assertEqual((ctx.exception.network, ctx.exception.amount), ("", ""))

    # ── Outcomes whose meaning is unchanged ──

    def test_first_402_without_a_signature_hands_off_to_the_plugin(self):
        self.responses = [payment_required()]

        kind, value = tools._paid_request("https://storefront.example/orders", body={})

        self.assertEqual(kind, "marker")
        self.assertTrue(value.startswith("PAYMENT_REQUIRED"))

    def test_server_error_before_any_payment_is_returned_as_is(self):
        self.responses = [FakeResponse(503)]

        kind, resp = tools._paid_request("https://storefront.example/orders", body={})

        self.assertEqual((kind, resp.status_code), ("response", 503))

    def test_signed_success_and_client_errors_are_returned_as_is(self):
        self.responses = [FakeResponse(201, {"order": {}}), FakeResponse(409, {"error": "Out of stock"})]

        for status in (201, 409):
            kind, resp = tools._paid_request("https://storefront.example/orders", body={}, headers=signed_header())
            self.assertEqual((kind, resp.status_code), ("response", status))

    # ── What the model sees ──

    def test_buy_product_reports_an_unconfirmed_payment_on_re_invocation(self):
        self.responses = [FakeResponse(402, {"error": "settlement failed"})]

        result = json.loads(tools.strands_buy_product("p1", headers=signed_header()))

        self.assertEqual(result["paymentStatus"], "unconfirmed")
        self.assertIn("Do not retry", result["guidance"])

    def test_generate_image_reports_an_unconfirmed_payment_on_re_invocation(self):
        self.responses = [requests.ConnectionError("reset")]

        result = json.loads(tools.strands_generate_image("a lighthouse at dusk", headers=signed_header()))

        self.assertEqual(result["paymentStatus"], "unconfirmed")


if __name__ == "__main__":
    unittest.main()
