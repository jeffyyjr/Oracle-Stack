import test from "node:test";
import assert from "node:assert/strict";
import { buildBoundedReply, extractBuyerBudget, planInboundReply } from "../sales-force.js";

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

test("missing buyer budget uses target price instead of becoming zero", () => {
  const result = buildBoundedReply({ classification: positive, offer: "lead automation", minimumPrice: 500, targetPrice: 1000 });
  assert.equal(result.allowed, true);
  assert.equal(result.price, 1000);
});

test("buyer budget is extracted only from explicit commercial language", () => {
  assert.equal(extractBuyerBudget({ text: "We can pay $850 for this." }), 850);
  assert.equal(extractBuyerBudget({ text: "Can you start on October 12?" }), null);
});

test("verified positive reply advances to a saved proposal plan", () => {
  const result = planInboundReply({
    classification: positive,
    campaign: { offer: "lead automation", minimum_price: 500, target_price: 1000, max_discount_percent: 20, currency: "USD" },
    reply: { text: "Interested. Our budget is $900." }
  });
  assert.equal(result.stage, "proposal");
  assert.equal(result.proposalStatus, "drafted");
  assert.equal(result.proposal.price, 900);
  assert.equal(result.proposal.autoSend, false);
});

test("positive reply without campaign boundaries is held at replied", () => {
  const result = planInboundReply({ classification: positive, campaign: { offer: "automation" }, reply: { text: "Interested." } });
  assert.equal(result.stage, "replied");
  assert.equal(result.proposalStatus, "held");
  assert.equal(result.proposal.reason, "commercial_boundaries_required");
});
