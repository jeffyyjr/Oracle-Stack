import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { validInboundSignature, correlateInboundReply } from "../outreach-fetch-guard.js";

test("inbound webhook requires matching HMAC evidence", () => {
  const secret = "test-secret";
  const raw = Buffer.from(JSON.stringify({ id: "in-1", inReplyTo: "out-1", text: "Interested" }));
  const signature = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  assert.equal(validInboundSignature(raw, `sha256=${signature}`, secret), true);
  assert.equal(validInboundSignature(raw, `sha256=${"0".repeat(64)}`, secret), false);
  assert.equal(validInboundSignature(raw, `sha256=${signature}`, ""), false);
});

test("reply correlation requires exactly one stored outbound message", () => {
  const lead = { id: "lead-1", stage: "contacted", external_message_id: "out-1" };
  assert.equal(correlateInboundReply([lead], "out-1").lead.id, "lead-1");
  assert.equal(correlateInboundReply([], "out-1").reason, "unknown_outbound_message");
  assert.equal(correlateInboundReply([lead, { ...lead, id: "lead-2" }], "out-1").reason, "ambiguous_outbound_message");
});

test("reply correlation refuses leads outside reply-eligible stages", () => {
  const result = correlateInboundReply([{ id: "lead-1", stage: "qualified", external_message_id: "out-1" }], "out-1");
  assert.equal(result.matched, false);
  assert.equal(result.reason, "lead_not_awaiting_reply");
});
