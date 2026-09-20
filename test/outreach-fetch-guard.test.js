import test from "node:test";
import assert from "node:assert/strict";
import { validOutreachReceipt } from "../outreach-fetch-guard.js";

test("outreach guard rejects ambiguous connector success", () => {
  assert.equal(validOutreachReceipt({}), false);
  assert.equal(validOutreachReceipt({ status: "queued", id: "q1" }), false);
  assert.equal(validOutreachReceipt({ accepted: true }), false);
});

test("outreach guard accepts only explicit receipt with message id", () => {
  assert.equal(validOutreachReceipt({ accepted: true, messageId: "m1" }), true);
  assert.equal(validOutreachReceipt({ status: "delivered", id: "m2" }), true);
});
