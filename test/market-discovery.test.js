import test from "node:test";
import assert from "node:assert/strict";
import {
  broadOpportunityIntent,
  buildDiscoveryQuerySpecs,
  buildAccessibleRescueSpecs,
  classifyDemandEvidence
} from "../market-discovery.js";

test("broad inventory-free request uses buyer radar", () => {
  const request = "Find me something legitimate I can sell without holding inventory, validate the demand, and figure out who would buy it.";
  assert.equal(broadOpportunityIntent(request), true);
  const plan = buildDiscoveryQuerySpecs(request);
  assert.equal(plan.strategy, "broad_inventory_free_buyer_radar");
  assert.ok(plan.specs.length >= 5);
  assert.ok(plan.specs.every(x => x.signalType === "demand"));
  assert.ok(plan.specs.every(x => ["upwork", "freelancer", "peopleperhour"].includes(x.channel)));
});

test("generic article evidence cannot qualify buyer demand", () => {
  assert.equal(classifyDemandEvidence({
    channel: "web_demand",
    signalType: "demand",
    verification: { status: "VERIFIED_OPEN" }
  }), "CONTEXT_ONLY");
});

test("verified direct listing qualifies", () => {
  assert.equal(classifyDemandEvidence({
    channel: "upwork",
    signalType: "demand",
    verification: { status: "VERIFIED_OPEN" }
  }), "QUALIFIED");
});

test("unverified direct listing remains verify-only", () => {
  assert.equal(classifyDemandEvidence({
    channel: "freelancer",
    signalType: "demand",
    verification: { status: "INACCESSIBLE" }
  }), "VERIFY");
});


test("accessible rescue avoids blocked marketplace-only dead end", () => {
  const specs = buildAccessibleRescueSpecs("Find me something legitimate I can sell without holding inventory");
  assert.ok(specs.length >= 3);
  assert.ok(specs.some(x => x.channel === "github"));
  assert.ok(specs.some(x => x.channel === "reddit"));
  assert.ok(specs.some(x => x.channel === "public_rfp"));
  assert.ok(specs.every(x => !["upwork", "freelancer", "peopleperhour"].includes(x.channel)));
});


test("home-service campaign uses business prospecting mode", () => {
  const plan = buildDiscoveryQuerySpecs([
    "Find home-service companies that could use faster lead response.",
    "Offer: AI lead-response and appointment-booking automation",
    "Target buyer: HVAC, plumbing, electrical, roofing, landscaping and similar home-service businesses"
  ].join("\n"));
  assert.equal(plan.strategy, "home_service_business_prospecting");
  assert.equal(plan.prospecting, true);
  assert.ok(plan.verticals.includes("hvac"));
  assert.ok(plan.specs.length >= 5);
  assert.ok(plan.specs.every(x => x.channel === "business_web"));
  assert.ok(plan.specs.every(x => x.signalType === "prospect"));
});
