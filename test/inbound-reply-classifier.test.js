import test from "node:test";
import assert from "node:assert/strict";
import { classifyInboundReply } from "../sales-force.js";

test("reply classifier requires provider evidence", () => {
  assert.deepEqual(classifyInboundReply({ text: "Interested" }), {
    accepted: false, classification: "unverified", action: "hold", reason: "missing_reply_evidence"
  });
});

test("reply classifier advances verified positive replies", () => {
  const result = classifyInboundReply({ text: "Interested. Send me a quote.", messageId: "reply-1", inReplyTo: "sent-1" });
  assert.equal(result.accepted, true);
  assert.equal(result.classification, "positive");
  assert.equal(result.action, "advance");
  assert.equal(result.stage, "replied");
});

test("reply classifier suppresses opt-outs before other intent", () => {
  const result = classifyInboundReply({ text: "I was interested, but unsubscribe me.", messageId: "reply-2", inReplyTo: "sent-2" });
  assert.equal(result.classification, "opt_out");
  assert.equal(result.action, "suppress");
  assert.equal(result.stage, "lost");
});

test("reply classifier closes clear negative replies and holds ambiguity", () => {
  assert.equal(classifyInboundReply({ text: "No thanks", messageId: "r3", inReplyTo: "s3" }).stage, "lost");
  const ambiguous = classifyInboundReply({ text: "Can you clarify what you mean?", messageId: "r4", inReplyTo: "s4" });
  assert.equal(ambiguous.classification, "needs_review");
  assert.equal(ambiguous.action, "hold");
});
