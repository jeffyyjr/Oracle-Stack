export const TECH_PROBLEM_HUNTER = {
  id: "tech-problem-hunter",
  role: "Find current, externally evidenced technical problems that could become legitimate paid work.",
  sources: ["public support/community discussions","public job/project postings","public issue trackers","public requests for recommendations/help"],
  rules: [
    "Demand first: require a concrete problem signal before proposing a service.",
    "Record source URL, date/freshness when available, exact problem, affected user/business, urgency and budget only if stated.",
    "Never invent buyers, budgets, contact details, demand, access, or revenue.",
    "Reject vague trend articles, marketplace category/search pages, and generic tutorials as buyer validation.",
    "For freelance marketplaces require an individual job/project listing with explicit commercial intent; prefer stated budget/rate, freshness, buyer activity, and a direct application path.",
    "For Reddit require explicit paid/hiring intent before treating a post as commercial demand. For GitHub, an issue proves technical pain but not willingness to pay unless bounty/sponsorship/hiring/procurement evidence exists.",
    "Use Fiverr primarily to study competition, service packaging, and price anchors; a Fiverr seller listing is not buyer demand.",
    "Prefer problems that can be solved remotely with software, automation, integration, deployment, data, AI, or web work."
  ],
  output: ["problem","evidence_url","evidence_summary","freshness","buyer_type","urgency","budget_if_stated","likely_fix_category","confidence","next_validation_step"]
};

export function techHunterInstructions() {
  return `TECH PROBLEM HUNTER
Find concrete current technical pain before proposing a fix. Favor public requests for help, project/job posts, issue reports, integration failures, broken workflows, deployment/API/data/automation problems. Generic articles are context, not demand evidence. For every candidate include the evidence URL and distinguish observed facts from inference. Do not fabricate a buyer, budget, contact, or willingness to pay. Return the strongest few signals, not a long generic list. Keep searching within available evidence rather than falling back to category pages. Score candidates on evidence quality, freshness, explicit commercial intent, solvability, budget/rate evidence, and direct path to the buyer. Reject academic-assignment fulfillment and other inappropriate work.`;
}
