export const buyerMatcher = {
  id: "buyer-matcher",
  description: "Turns a validated opportunity into a buyer profile, matching criteria, and ethical acquisition plan.",
  buildPrompt({ opportunity, constraints = {} }) {
    return `Match this opportunity to likely buyers:
${JSON.stringify(opportunity)}
Constraints: ${JSON.stringify(constraints)}
Return JSON only: {"buyer_segments":[{"segment":"","need":"","qualification_signals":[],"where_to_find":[],"offer_angle":"","objections":[]}],"match_score":0,"why":"","next_actions":[]}
Do not fabricate named buyers or contact information. Do not recommend spam, deception, impersonation, fake scarcity, or bypassing platform rules. Prefer buyers showing genuine intent.`;
  }
};
