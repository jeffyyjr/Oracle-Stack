import { verifyListings } from "./listing-verifier.js";
const DEFAULT_TIMEOUT_MS = 12000;

function cleanText(value = "") {
  return String(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`Discovery source returned HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

async function searchBrave(query, count, channel = "general", signalType = "demand") {
  if (!process.env.BRAVE_SEARCH_API_KEY) return [];
  const url = new URL("https://api.search.brave.com/res/v1/llm/context");
  url.searchParams.set("q", query);
  url.searchParams.set("country", "US");
  url.searchParams.set("search_lang", "en");
  url.searchParams.set("count", String(Math.min(12, Math.max(5, count))));
  url.searchParams.set("freshness", "pm");
  url.searchParams.set("maximum_number_of_urls", "8");
  url.searchParams.set("maximum_number_of_tokens", "3072");
  url.searchParams.set("maximum_number_of_tokens_per_url", "768");
  url.searchParams.set("context_threshold_mode", "strict");
  url.searchParams.set("enable_source_metadata", "true");
  const data = await fetchJson(url, { headers: { Accept: "application/json", "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY } });
  return (data?.grounding?.generic || []).map(item => ({
    title: item.title,
    url: item.url,
    snippet: cleanText((item.snippets || []).join(" ")),
    source: "brave_llm_context",
    channel,
    signalType
  }));
}

async function searchSerper(query, count, channel = "general", signalType = "demand") {
  if (!process.env.SERPER_API_KEY) return [];
  const data = await fetchJson("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: count })
  });
  return (data?.organic || []).slice(0, count).map(item => ({ title: item.title, url: item.link, snippet: cleanText(item.snippet), source: "serper", channel, signalType }));
}

export function discoveryEnabled() {
  return Boolean(process.env.BRAVE_SEARCH_API_KEY || process.env.SERPER_API_KEY);
}

export async function discoverMarketEvidence(request, { count = 14 } = {}) {
  if (!discoveryEnabled()) return { enabled: false, provider: null, queries: [], results: [] };
  const goal = String(request).slice(0, 360);
  // Search engines perform better with a compact problem taxonomy than with the full mission prompt.
  const techTerms = "API integration automation SaaS AWS deployment backend database AI workflow bug fix";
  // Demand first: discover concrete current need across channels before researching fulfillment.
  const techIntent = /tech|software|saas|app|website|api|integration|automation|deploy|bug|code|data|ai|computer/i.test(goal);
  const sideHustleSeed = /side\s*hustle|business idea|opportunity radar|income idea|money[- ]making idea/i.test(goal) ? [
    { channel: "sidehustleindex", signalType: "idea_seed", q: `site:sidehustleindex.com/idea/ ${goal.replace(/https?:\\/\\/\\S+/g, "").slice(0,180)}` }
  ] : [];
  const querySpecs = techIntent ? [
    { channel: "upwork", signalType: "demand", q: `site:upwork.com/freelance-jobs/apply/ ("API" OR automation OR AWS OR SaaS OR backend) ("Fixed Price" OR hourly OR budget) -academic -homework` },
    { channel: "freelancer", signalType: "demand", q: `site:freelancer.com/projects/ ("API" OR automation OR AWS OR backend OR integration) (budget OR fixed OR hourly) -academic -homework` },
    { channel: "peopleperhour", signalType: "demand", q: `site:peopleperhour.com/freelance-jobs/ ("API" OR automation OR SaaS OR integration OR bug) (budget OR fixed OR hourly) -academic -homework` },
    { channel: "reddit", signalType: "demand", q: `site:reddit.com/r/forhire OR site:reddit.com/r/freelance ("[Hiring]" OR "will pay" OR budget) (${techTerms})` },
    { channel: "github", signalType: "demand", q: `site:github.com/issues (bounty OR "$" OR "paid" OR sponsor) (${techTerms})` },
    { channel: "public_rfp", signalType: "demand", q: `("request for proposal" OR RFP OR solicitation OR "request for quote") (${techTerms}) (deadline OR due)` },
  ] : [
    { channel: "web_demand", signalType: "demand", q: `${goal} ("looking for" OR "need help" OR "need a" OR "recommend" OR "request quote" OR "seeking") buyer customer` },
    { channel: "web_pain", signalType: "demand", q: `${goal} (problem OR complaint OR frustrated OR "can't find" OR "need someone") customer business` },
  ];
  querySpecs.push(...sideHustleSeed);\n  const queries = querySpecs.map(x => x.q);
  const provider = process.env.BRAVE_SEARCH_API_KEY ? "brave" : "serper";
  const search = provider === "brave" ? searchBrave : searchSerper;
  const perQuery = techIntent ? 8 : Math.max(4, Math.ceil(count / 2));
  const batches = await Promise.allSettled(querySpecs.map(spec => search(spec.q, perQuery, spec.channel, spec.signalType)));
  const seen = new Set(), results = [], rejected = [];
  const looksLikeListing = (item) => {
    const u = String(item?.url || "").toLowerCase();
    const t = `${item?.title || ""} ${item?.snippet || ""}`.toLowerCase();
    if (item?.signalType !== "demand") return true;
    if (["upwork","freelancer","peopleperhour"].includes(item?.channel)) {
      const detailPath = /upwork\.com\/freelance-jobs\/apply\//.test(u) || /freelancer\.com\/projects\//.test(u) || /peopleperhour\.com\/freelance-jobs\//.test(u);
      const commercialText = /(fixed-price|fixed price|hourly|budget|\$\s?\d|£\s?\d|€\s?\d|posted|proposals|hiring|looking for|we need|seeking)/.test(t);
      const academicRisk = /(homework|school assignment|college assignment|university assignment|coursework|exam help)/.test(t);
      return detailPath && commercialText && !academicRisk;
    }
    if (item?.channel === "github") return /\/issues\/\d+/.test(u);
    if (item?.channel === "reddit") return /\/comments\//.test(u) && /(hire|hiring|paid|budget|looking for someone|need someone|will pay)/.test(t);
    if (item?.channel === "public_rfp") return /(rfp|tender|procurement|solicitation|request for proposal|request for quote)/.test(t);
    return true;
  };
  for (const batch of batches) {
    if (batch.status !== "fulfilled") continue;
    for (const item of batch.value) {
      if (!item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      if (!looksLikeListing(item)) { rejected.push(item); continue; }
      results.push(item);
    }
  }
  const selected = results.slice(0, count);
  const verified = techIntent ? await verifyListings(selected, 6) : [];
  const verificationByUrl = new Map(verified.map(x => [x.url, x.verification]));
  const enriched = selected.map(x => ({ ...x, verification: verificationByUrl.get(x.url) || null }));
  return { enabled: true, provider, queries, results: enriched, strategy: techIntent ? "tech_individual_listing_demand_first" : "demand_first",
    rejectedCount: rejected.length,
    demandEvidenceCount: results.filter(x => x.signalType === "demand").length,
    supplyEvidenceCount: results.filter(x => x.signalType !== "demand").length };
}

export function evidencePromptBlock(evidence) {
  if (!evidence?.enabled) return "\nLIVE DISCOVERY: unavailable. Treat market claims as hypotheses requiring validation.";
  if (!evidence.results.length) return `\nLIVE DISCOVERY: ${evidence.provider} was queried but returned no usable evidence. Do not claim validation.`;
  const rows = evidence.results.map((x,i)=>`[${i+1}] [${x.channel || "web"} / ${x.signalType || "demand"}] ${x.title}\nURL: ${x.url}\nVerification: ${x.verification?.status || "NOT_CHECKED"} at ${x.verification?.verifiedAt || "n/a"} (HTTP ${x.verification?.httpStatus ?? "n/a"})\nSnippet: ${x.snippet}\nLive page evidence: ${x.verification?.evidence || "unavailable"}`).join("\n\n");
  return `\nLIVE MARKET DISCOVERY (${evidence.provider}; DEMAND-FIRST). First identify concrete current buyer intent or a specific pain signal. For tech revenue work, individual listings/issues/posts are required for demand qualification; category pages, search pages, generic articles, tutorials, and trend pages are context only and must not qualify as a buyer opportunity. Do NOT choose a product/service merely because a generic article says the business model is viable. Only after a demand signal is identified should you propose a fulfillment path, and label supply/pricing as unverified until separately checked. These are extracted web chunks plus best-effort direct public-page verification. VERIFIED_OPEN may be treated as evidence the public page currently appears actionable; CLOSED must be rejected; INACCESSIBLE or UNKNOWN must remain VERIFY. Never bypass login walls, CAPTCHAs, access controls, or platform protections. Treat items marked supply_competition () as evidence of available services, competition, packaging, or price anchors only — never as proof that a buyer currently wants to pay. Side Hustle Index items are IDEA SEEDS only: never accept their earnings, demand, crowding, difficulty, or viability claims as validated facts. Independently validate them against current buyer-demand and competition evidence before recommending deeper investigation. Cite URLs next to claims and explicitly separate observed evidence from inference. Never invent a buyer, supplier, price, contact, sale, or revenue figure. If direct demand is weak, say so and give the next validation action instead of claiming validation.\n\n${rows}`;
}
