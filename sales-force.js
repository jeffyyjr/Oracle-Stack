import crypto from "crypto";

export const SALES_STAGES = [
  "discovered", "qualified", "outreach_ready", "contacted", "replied", "proposal", "won", "lost"
];

const CLOSED = new Set(["won", "lost"]);

function text(value, max = 2000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function money(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) / 100 : null;
}

export function explicitBuyerEmail(item = {}) {
  const candidates = [
    item.buyerEmail, item.buyer_email, item.contactEmail, item.contact_email, item.email,
    item.verification?.buyerEmail, item.verification?.contactEmail, item.verification?.email
  ];
  for (const value of candidates) {
    const candidate = String(value || "").trim().toLowerCase();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate)) return candidate.slice(0, 320);
  }
  return null;
}

export function extractBuyerBudget(input = {}) {
  const explicit = money(input.buyerBudget ?? input.budget ?? input.amount);
  if (explicit !== null) return explicit;
  const body = text(input.text || input.body || input.message, 8000);
  const match = body.match(/(?:budget(?:\s+is|\s+of)?|up\s+to|can\s+(?:do|pay)|pay|spend|for)\s*(?:is\s*)?(?:usd\s*)?\$?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/i)
    || body.match(/(?:usd\s*|\$\s*)([0-9][0-9,]*(?:\.\d{1,2})?)/i);
  return match ? money(match[1].replaceAll(",", "")) : null;
}

export function normalizeCampaign(input = {}) {
  const objective = text(input.objective, 1200);
  if (!objective) throw new Error("Campaign objective is required.");
  const outreachMode = ["draft", "auto"].includes(input.outreachMode) ? input.outreachMode : "draft";
  const cadenceMinutes = Math.max(60, Math.min(10080, Number(input.cadenceMinutes) || 1440));
  const dailyRunLimit = Math.max(1, Math.min(24, Number(input.dailyRunLimit) || 1));
  const minimumLeadScore = Math.max(0, Math.min(100, Number(input.minimumLeadScore) || 55));
  const minimumPrice = money(input.minimumPrice);
  const targetPrice = money(input.targetPrice);
  const maxDiscountPercent = Math.max(0, Math.min(50, Number(input.maxDiscountPercent) || 0));
  const currency = text(input.currency || "USD", 8).toUpperCase();
  if ((minimumPrice === null) !== (targetPrice === null)) throw new Error("Minimum and target price must be set together.");
  if (minimumPrice !== null && targetPrice < minimumPrice) throw new Error("Target price must be at least the minimum price.");
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
    minimumPrice,
    targetPrice,
    maxDiscountPercent,
    currency,
    maxLeadsPerRun: Math.max(1, Math.min(25, Number(input.maxLeadsPerRun) || 8)),
    authorizedAutoOutreach: outreachMode === "auto" && input.authorizedAutoOutreach === true
  };
}

const RELEVANCE_STOP = new Set(["the","and","for","with","that","this","from","your","their","real","currently","asking","help","business","businesses","service","services","similar","home","sales","automation","using","into","through","about","only","open","buyer","target","offer"]);

function relevanceTerms(value = "") {
  return [...new Set(String(value).toLowerCase().replace(/[^a-z0-9+#.-]+/g," ").split(/\s+/).filter(x => x.length >= 4 && !RELEVANCE_STOP.has(x)))];
}

export function campaignEvidenceRelevant(campaign = {}, item = {}) {
  const hayText = `${item.title || ""} ${item.snippet || ""}`.toLowerCase();
  const hay = new Set(relevanceTerms(hayText));
  const buyerTerms = relevanceTerms(campaign.targetBuyer || campaign.target_buyer || "");
  const problemTerms = relevanceTerms(`${campaign.offer || ""} ${campaign.objective || ""}`);
  const buyerMatches = buyerTerms.filter(x => hay.has(x)).length;
  const problemMatches = problemTerms.filter(x => hay.has(x)).length;
  const channel = String(item.channel || item.evidence?.channel || "").toLowerCase();

  if (/micro bounty|bounty alert|best .* tools|ranked for 20\d\d|software crm|autonomous ai systems/i.test(hayText)) return false;
  if (buyerTerms.length) {
    if (buyerMatches < 1) return false;
    if (problemTerms.length && problemMatches < 1) return false;
  } else if (problemTerms.length && problemMatches < 2) {
    return false;
  }

  if (channel === "github" && !/software|developer|coding|api|github|bounty/i.test(String(campaign.targetBuyer || campaign.target_buyer || "") + " " + String(campaign.offer || ""))) {
    return false;
  }
  return true;
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
    buyerEmail: explicitBuyerEmail(item),
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

export function classifyInboundReply(input = {}) {
  const body = text(input.text || input.body || input.message, 8000);
  const providerMessageId = text(input.messageId || input.id, 240);
  const inReplyTo = text(input.inReplyTo || input.replyToMessageId, 240);
  if (!body || !providerMessageId || !inReplyTo) {
    return { accepted: false, classification: "unverified", action: "hold", reason: "missing_reply_evidence" };
  }

  const normalized = body.toLowerCase();
  if (/\b(unsubscribe|remove me|stop emailing|do not (email|contact)|don't (email|contact)|no more emails|opt[ -]?out)\b/i.test(normalized)) {
    return { accepted: true, classification: "opt_out", action: "suppress", stage: "lost", providerMessageId, inReplyTo };
  }
  if (/\b(not interested|no thanks|no thank you|already handled|filled the role|found someone|went with someone else)\b/i.test(normalized)) {
    return { accepted: true, classification: "negative", action: "close", stage: "lost", providerMessageId, inReplyTo };
  }
  if (/\b(interested|tell me more|send (me )?(a )?(quote|proposal|plan)|what (would|will) (it|this) cost|how much|availability|when can you start|schedule|book|call|meeting)\b/i.test(normalized)) {
    return { accepted: true, classification: "positive", action: "advance", stage: "replied", providerMessageId, inReplyTo };
  }
  return { accepted: true, classification: "needs_review", action: "hold", stage: "replied", providerMessageId, inReplyTo };
}

export function buildBoundedReply(input = {}) {
  const classification = input.classification || {};
  const offer = text(input.offer, 1000);
  const scope = text(input.scope || offer, 1000);
  const floor = money(input.minimumPrice);
  const target = money(input.targetPrice);
  const buyerBudget = money(input.buyerBudget);
  const maxDiscountPercent = Math.max(0, Math.min(50, Number(input.maxDiscountPercent) || 0));
  const currency = text(input.currency || "USD", 8).toUpperCase();

  if (classification.accepted !== true || classification.classification !== "positive") {
    return { allowed: false, action: "hold", reason: "verified_positive_reply_required" };
  }
  if (!offer || floor === null || target === null || target < floor) {
    return { allowed: false, action: "hold", reason: "commercial_boundaries_required" };
  }

  const discountFloor = Math.round(target * (1 - maxDiscountPercent / 100) * 100) / 100;
  const effectiveFloor = Math.max(floor, discountFloor);
  if (buyerBudget !== null && buyerBudget < effectiveFloor) {
    return {
      allowed: false,
      action: "escalate",
      reason: "buyer_budget_below_authorized_floor",
      boundary: { minimumPrice: effectiveFloor, targetPrice: target, currency }
    };
  }

  const price = buyerBudget === null ? target : Math.max(effectiveFloor, Math.min(target, buyerBudget));
  const reply = `Thanks for the reply. For ${scope}, the price is ${currency} ${price.toFixed(2)}. I can provide a concise scope and delivery plan before anything is committed. If that range works, the next step is to confirm scope and timing.`;
  return {
    allowed: true,
    action: "draft",
    autoSend: false,
    price,
    currency,
    reply,
    boundary: { minimumPrice: effectiveFloor, targetPrice: target, maxDiscountPercent }
  };
}

export function planInboundReply({ classification = {}, campaign = {}, reply = {} } = {}) {
  let stage = "replied";
  if (["close", "suppress"].includes(classification.action)) stage = "lost";
  if (classification.classification !== "positive") {
    return { stage, proposal: null, proposalStatus: classification.action === "hold" ? "review" : "none" };
  }
  const proposal = buildBoundedReply({
    classification,
    offer: campaign.offer,
    scope: reply.scope || campaign.offer,
    minimumPrice: campaign.minimum_price ?? campaign.minimumPrice,
    targetPrice: campaign.target_price ?? campaign.targetPrice,
    maxDiscountPercent: campaign.max_discount_percent ?? campaign.maxDiscountPercent,
    currency: campaign.currency,
    buyerBudget: extractBuyerBudget(reply)
  });
  if (proposal.allowed) return { stage: "proposal", proposal, proposalStatus: "drafted" };
  if (proposal.action === "escalate") return { stage: "replied", proposal, proposalStatus: "escalated" };
  return { stage: "replied", proposal, proposalStatus: "held" };
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
