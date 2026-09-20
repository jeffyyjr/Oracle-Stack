import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCampaign, scoreEvidence, evidenceToLead, normalizeDeliveryReceipt, nextStage, summarizePipeline } from "../sales-force.js";

test("campaign defaults to a safe recurring research loop", () => {
  const campaign = normalizeCampaign({ objective: "Find buyers with automation pain" });
  assert.equal(campaign.status, "running");
  assert.equal(campaign.outreachMode, "draft");
  assert.equal(campaign.authorizedAutoOutreach, false);
  assert.equal(campaign.dailyRunLimit, 1);
  assert.equal(campaign.minimumPrice, null);
  assert.equal(campaign.targetPrice, null);
});

test("campaign validates bounded proposal pricing", () => {
  const campaign = normalizeCampaign({ objective: "Sell automation", minimumPrice: 500, targetPrice: 1000, maxDiscountPercent: 20 });
  assert.equal(campaign.minimumPrice, 500);
  assert.equal(campaign.targetPrice, 1000);
  assert.equal(campaign.maxDiscountPercent, 20);
  assert.throws(() => normalizeCampaign({ objective: "Bad bounds", minimumPrice: 1000, targetPrice: 500 }), /Target price/);
  assert.throws(() => normalizeCampaign({ objective: "Half bounds", minimumPrice: 500 }), /set together/);
});

test("verified commercial demand qualifies above a generic page", () => {
  const strong = scoreEvidence({ signalType:"demand", title:"Hiring API automation help - $1,000 budget", url:"https://example.com/jobs/123", verification:{status:"VERIFIED_OPEN"} });
  const weak = scoreEvidence({ signalType:"idea_seed", title:"Best side hustles", url:"https://example.com/blog" });
  assert.ok(strong >= 80);
  assert.ok(weak < strong);
});

test("lead creation drafts outreach only for qualified evidence", () => {
  const campaign = normalizeCampaign({ objective:"Find API work", offer:"a tested API integration", minimumLeadScore:55 });
  const lead = evidenceToLead(campaign, { signalType:"demand", title:"Need API help", snippet:"We need someone to repair our integration", url:"https://example.com/projects/1", verification:{status:"VERIFIED_OPEN"} });
  assert.equal(lead.stage, "qualified");
  assert.match(lead.outreachDraft, /tested API integration/);
});

test("delivery receipts require explicit acceptance and a provider message id", () => {
  assert.deepEqual(normalizeDeliveryReceipt({}), { accepted:false, messageId:null, status:"unconfirmed" });
  assert.equal(normalizeDeliveryReceipt({ status:"queued", id:"q1" }).accepted, false);
  assert.equal(normalizeDeliveryReceipt({ accepted:true }).accepted, false);
  assert.deepEqual(normalizeDeliveryReceipt({ accepted:true, messageId:"m1" }), { accepted:true, messageId:"m1", status:"accepted" });
  assert.deepEqual(normalizeDeliveryReceipt({ status:"delivered", id:"m2" }), { accepted:true, messageId:"m2", status:"delivered" });
});

test("stage machine blocks unsafe jumps", () => {
  assert.equal(nextStage("qualified", "outreach_ready"), "outreach_ready");
  assert.throws(() => nextStage("discovered", "contacted"));
  assert.throws(() => nextStage("won", "replied"));
});

test("pipeline summary tracks actual wins", () => {
  const summary = summarizePipeline([
    {stage:"proposal",estimated_value:500},
    {stage:"won",actual_revenue:900,actual_margin:600},
    {stage:"lost",estimated_value:100}
  ]);
  assert.equal(summary.pipelineValue,500);
  assert.equal(summary.wonRevenue,900);
  assert.equal(summary.wonMargin,600);
});
