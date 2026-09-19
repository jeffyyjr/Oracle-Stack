export const opportunityFinder = {
  id: "opportunity-finder",
  description: "Finds legitimate products/services with evidence of buyer demand and a plausible margin.",
  buildPrompt({ goal, constraints = {} }) {
    return `Find sale opportunities for this goal: ${goal}
Constraints: ${JSON.stringify(constraints)}
Return JSON only: {"opportunities":[{"name":"","type":"product|service|digital|lead","buyer_problem":"","demand_evidence":[],"likely_buyers":[],"supplier_path":"","estimated_buy_price":null,"estimated_sell_price":null,"estimated_margin":null,"risks":[],"next_validation_step":""}]}
Do not invent suppliers, buyers, prices, or demand evidence. Separate verified facts from hypotheses. Prefer legal, low-capital, no-inventory opportunities. Treat idea directories such as Side Hustle Index as candidate/seed sources only, never as proof of demand or earnings. Independently validate current buyer demand, competition, startup requirements, automation potential, time-to-revenue, and evidence quality before elevating an idea.`;
  }
};
