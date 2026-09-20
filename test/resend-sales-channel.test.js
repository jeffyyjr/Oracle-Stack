import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { explicitBuyerEmail, evidenceToLead } from "../sales-force.js";
import { validResendWebhookSignature } from "../outreach-fetch-guard.js";

test("buyer email is accepted only from explicit structured evidence", () => {
  assert.equal(explicitBuyerEmail({ contactEmail: "Buyer@Example.com" }), "buyer@example.com");
  assert.equal(explicitBuyerEmail({ snippet: "email me at hidden@example.com" }), null);
  assert.equal(explicitBuyerEmail({ email: "not-an-email" }), null);
});

test("evidenceToLead carries an explicit buyer email without inventing one", () => {
  const campaign = { id: "c1", minimumLeadScore: 0, offer: "automation" };
  const lead = evidenceToLead(campaign, {
    title: "Need automation help",
    snippet: "Looking for help",
    url: "https://example.com/jobs/1",
    contactEmail: "buyer@example.com",
    verification: { status: "VERIFIED_OPEN" },
    signalType: "demand"
  });
  assert.equal(lead.buyerEmail, "buyer@example.com");
});

test("Resend webhook signatures are verified using Standard Webhooks format", () => {
  const raw = Buffer.from(JSON.stringify({ type: "email.received", data: { email_id: "e1" } }));
  const now = 1760000000;
  const secretBytes = Buffer.from("oracle-test-secret");
  const secret = "whsec_" + secretBytes.toString("base64");
  const id = "msg_test";
  const timestamp = String(now);
  const signature = crypto.createHmac("sha256", secretBytes)
    .update(`${id}.${timestamp}.${raw.toString("utf8")}`)
    .digest("base64");
  assert.equal(validResendWebhookSignature(raw, {
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`
  }, secret, now), true);
  assert.equal(validResendWebhookSignature(raw, {
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": "v1,bad"
  }, secret, now), false);
});
