import crypto from "crypto";

export const SALES_STAGES = [
  "discovered", "qualified", "outreach_ready", "contacted", "replied", "proposal", "won", "lost"
];

const CLOSED = new Set(["won", "lost"]);

function text(value, max = 2000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function money(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) / 100 : null;
}

export function normalizeCampaign(input = {}) {
  const objective = text(input.objective, 1200);
  if (!objective) throw new Error("Campaign objective is required.");
  const outreachMode = ["draft", "auto"].includes(input.outreachMode) ? input.outreachMode : "draft";
  const cadenceMinutes = Math.max(60, Math.min(10080, Number(input.cadenceMinutes) || 1440));
  const dailyRunLimit = Math.max(1, Math.min(24, Number(input.dailyRunLimit) || 1));
  const minimumLeadScore = Math.max(0, Math.min(100, Number(input.minimumLeadScore) || 55));
  return {
    id: crypto.randomUUID(),
    name: text(input.name || objective, 120),
    objective,
    offer: text(input.offer, 1000),
    targetBuyer: text(input.targetBuyer, 500),
    constraints: text(input.constraints, 1200),
    outreachMode,
    status: input.status === "paused" ? "paused" : "running",
    cadenceMinutes,
    dailyRunLimit,
    minimumLeadScore,
    maxLeadsPerRun: Math.max(1, Math.min(25, Number(input.maxLeadsPerRun) || 8)),
    authorizedAutoOutreach: outreachMode === "auto" && input.authorizedAutoOutreach === true
  };
}

function explicitCommercialIntent(item) {
  const haystack = `${item.title || ""} ${item.snippet || ""}`.toLowerCase();
  return /(hiring|looking for|need (a|an|someone|help)|seeking|request for (proposal|quote)|rfp|budget|fixed.price|hourly|will pay|bounty|paid)/.test(haystack);
}

export function scoreEvidence(item = {}) {
  let score = 20;
  if (item.signalType === "demand") score += 20;
  if (explicitCommercialIntent(item)) score += 20;
  if (item.verification?.status === "VERIFIED_OPEN") score += 25;
  if (item.verification?.status === "CLOSED") score -= 70;
  if (item.verification?.status === "INACCESSIBLE") score -= 10;
  if (/\/(jobs?|projects?|issues?|comments?)\//i.test(item.url || "")) score += 10;
  if (/\b(\$|usd|budget|rate|hourly|fixed price)\b/i.test(`${item.title || ""} ${item.snippet || ""}`)) score += 5;
  return Math.max(0, Math.min(100, score));
}

export function evidenceToLead(campaign, item) {
  const score = scoreEvidence(item);
  const qualified = score >= campaign.minimumLeadScore && item.verification?.status !== "CLOSED";
  const sourceUrl = text(item.url, 2000);
  return {
    id: crypto.randomUUID(),
    campaignId: campaign.id,
    name: text(item.title || "Demand signal", 240),
    source: text(item.source || item.channel || "web", 80),
    sourceUrl,
    buyerProblem: text(item.snippet || item.title, 1600),
    evidence: {
      channel: item.channel || null,
      signalType: item.signalType || null,
      verification: item.verification || null,
      observedAt: new Date().toISOString()
    },
    score,
    stage: qualified ? "qualified" : "discovered",
    outreachDraft: qualified ? buildOutreachDraft(campaign, item) : "",
    estimatedValue: null,
    estimatedMargin: null
  };
}

export function buildOutreachDraft(campaign, item) {
  const problem = text(item.snippet || item.title, 420);
  const offer = campaign.offer || "a focused solution to this problem";
  return `Hi — I saw your request about ${problem}. We may be able to help with ${offer}. If the need is still open, I can send a short plan with scope, timing, and a clear price. No pressure if it has already been handled.`;
}

export function normalizeDeliveryReceipt(result = {}) {
  const status = text(result.status || result.deliveryStatus, 40).toLowerCase();
  const messageId = text(result.messageId || result.id, 240);
  const accepted = result.accepted === true || result.sent === true || ["accepted", "sent", "delivered"].includes(status);
  if (!accepted || !messageId) {
    return { accepted: false, messageId: null, status: status || "unconfirmed" };
  }
  return { accepted: true, messageId, status: status || "accepted" };
}

export function nextStage(current, requested) {
  if (!SALES_STAGES.includes(current) || !SALES_STAGES.includes(requested)) throw new Error("Invalid sales stage.");
  if (CLOSED.has(current) && current !== requested) throw new Error("Closed deals cannot be reopened automatically.");
  const from = SALES_STAGES.indexOf(current), to = SALES_STAGES.indexOf(requested);
  if (to > from + 1 && !["won", "lost"].includes(requested)) throw new Error("Sales stages must advance one step at a time.");
  return requested;
}

export function campaignDue(campaign, now = new Date()) {
  if (campaign.status !== "running") return false;
  if (Number(campaign.runs_today || 0) >= Number(campaign.daily_run_limit || campaign.dailyRunLimit || 1)) return false;
  const next = campaign.next_run_at ? new Date(campaign.next_run_at) : null;
  return !next || Number.isNaN(next.getTime()) || next <= now;
}

export function summarizePipeline(leads = []) {
  const stages = Object.fromEntries(SALES_STAGES.map(stage => [stage, 0]));
  let pipelineValue = 0, wonRevenue = 0, wonMargin = 0;
  for (const lead of leads) {
    if (stages[lead.stage] !== undefined) stages[lead.stage]++;
    const value = money(lead.actual_revenue ?? lead.estimated_value) || 0;
    const margin = money(lead.actual_margin ?? lead.estimated_margin) || 0;
    if (!CLOSED.has(lead.stage)) pipelineValue += value;
    if (lead.stage === "won") { wonRevenue += value; wonMargin += margin; }
  }
  return { totalLeads: leads.length, stages, pipelineValue, wonRevenue, wonMargin };
}
