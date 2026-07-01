# Agentic Commerce: A Concise Guide

Thanks for your purchase. This DRM-free guide is a sample digital deliverable
for the agent-economy storefront reference architecture.

## What agentic commerce is

Agentic commerce is the pattern where an autonomous software agent, acting for a
user within a spend-capped budget, discovers a priced resource, pays for it over
an open payment protocol, and receives the goods, all without a human completing
a checkout form.

## The building blocks shown in this sample

1. A priced HTTP resource that answers an unpaid request with HTTP 402 and a
   machine-readable list of payment requirements.
2. A payment primitive the agent uses to produce a signed payment proof against
   a budgeted session.
3. A facilitator that verifies the proof and settles the transfer on chain.
4. Fulfillment that runs only after settlement succeeds, so a buyer is never
   charged for goods that cannot be delivered.

## Why it matters

The same flow generalizes across industries. Anything an agent can be trusted
to buy within a budget, data, compute, content, licenses, or physical goods,
can be sold this way without bespoke per-buyer integrations.

This file is intentionally simple. Replace it with your own deliverable when you
adapt the sample.
