import test from "node:test";
import assert from "node:assert/strict";
import { gmailOutreachEligible } from "../gmail-connector.js";

test("Gmail outreach is limited to direct-email-safe opportunities", () => {
  assert.equal(gmailOutreachEligible({ buyerEmail: "buyer@example.com", evidence: { channel: "public_rfp" } }), true);
  assert.equal(gmailOutreachEligible({ buyerEmail: "buyer@example.com", evidence: { channel: "direct_email" } }), true);
  assert.equal(gmailOutreachEligible({ buyerEmail: "buyer@example.com", evidence: { channel: "upwork" } }), false);
  assert.equal(gmailOutreachEligible({ evidence: { channel: "public_rfp" } }), false);
});
