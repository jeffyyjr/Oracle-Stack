import { opportunityFinder } from "./agents/opportunity-finder.js";
import { buyerMatcher } from "./agents/buyer-matcher.js";
import { dealOrchestrator } from "./agents/deal-orchestrator.js";

export function opportunityPipelinePlan(goal, constraints = {}) {
  return {
    kind: "revenue_opportunity",
    goal,
    constraints,
    orchestrator: dealOrchestrator,
    agents: [
      { id: opportunityFinder.id, prompt: opportunityFinder.buildPrompt({ goal, constraints }) },
      { id: buyerMatcher.id, deferred: true, note: "Run after Oracle validates and selects an opportunity." }
    ],
    successMetrics: ["validated_demand", "qualified_buyers", "positive_replies", "deals", "gross_revenue", "gross_margin"]
  };
}
