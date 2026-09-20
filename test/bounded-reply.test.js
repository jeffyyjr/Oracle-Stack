import test from "node:test";
import assert from "node:assert/strict";
import { buildBoundedReply } from "../sales-force.js";

const positive = { accepted: true, classification: "positive" };

test("bounded reply requires verified positive reply", () => {
  assert.equal(buildBoundedReply({ classification: { accepted: true, classification: "needs_review" }, offer: "automation", minimumPrice: 500, targetPrice: 800 }).allowed, false);
});

test("bounded reply requires explicit commercial boundaries", () => {
  assert.equal(buildBoundedReply({ classification: positive, offer: "automation" }).reason, "commercial_boundaries_required");
});

test("bounded reply drafts inside authorized range without auto sending", () => {
  const result = buildBoundedReply({ classification: positive, offer: "lead automation", scope: "lead intake and booking automation", minimumPrice: 500, targetPrice: 1000, maxDiscountPercent: 20, buyerBudget: 900 });
  assert.equal(result.allowed, true);
  assert.equal(result.price, 900);
  assert.equal(result.autoSend, false);
  assert.match(result.reply, /USD 900\.00/);
});

test("bounded reply escalates instead of negotiating below floor", () => {
  const result = buildBoundedReply({ classification: positive, offer: "lead automation", minimumPrice: 700, targetPrice: 1000, maxDiscountPercent: 20, buyerBudget: 600 });
  assert.equal(result.allowed, false);
  assert.equal(result.action, "escalate");
  assert.equal(result.boundary.minimumPrice, 800);
});
