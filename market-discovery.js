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
  // Demand first: discover concrete current need across channels before researching fulfillment.
  const techIntent = /tech|software|saas|app|website|api|integration|automation|deploy|bug|code|data|ai|computer/i.test(goal);
  const querySpecs = techIntent ? [
    { channel: "github", signalType: "demand", q: `site:github.com/issues ${goal} ("need help" OR "help wanted" OR "bug" OR "feature request" OR "looking for")` },
    { channel: "reddit", signalType: "demand", q: `site:reddit.com ${goal} ("need help" OR "looking for someone" OR "how do I fix" OR "will pay" OR "hire")` },
    { channel: "freelance_jobs", signalType: "demand", q: `${goal} (site:upwork.com/freelance-jobs OR site:freelancer.com/projects OR site:peopleperhour.com/freelance-jobs) ("looking for" OR "need" OR "seeking")` },
    { channel: "public_rfp", signalType: "demand", q: `${goal} ("request for proposal" OR RFP OR tender OR procurement OR "request for quote") software technology` },
    // Fiverr is primarily supply/competition evidence. Use it to package and price an offer, never as proof of a buyer.
    { channel: "fiverr", signalType: "supply_competition", q: `site:fiverr.com ${goal} (software OR automation OR API OR AI OR bug OR integration)` }
  ] : [
    { channel: "web_demand", signalType: "demand", q: `${goal} ("looking for" OR "need help" OR "need a" OR "recommend" OR "request quote" OR "seeking") buyer customer` },
    { channel: "web_pain", signalType: "demand", q: `${goal} (problem OR complaint OR frustrated OR "can't find" OR "need someone") customer business` },
    { channel: "fiverr", signalType: "supply_competition", q: `site:fiverr.com ${goal}` }
  ];
  const queries = querySpecs.map(x => x.q);
  const provider = process.env.BRAVE_SEARCH_API_KEY ? "brave" : "serper";
  const search = provider === "brave" ? searchBrave : searchSerper;
  const perQuery = techIntent ? 6 : Math.max(4, Math.ceil(count / 2));
  const batches = await Promise.allSettled(querySpecs.map(spec => search(spec.q, perQuery, spec.channel, spec.signalType)));
  const seen = new Set(), results = [];
  const looksLikeListing = (item) => {
    const u = String(item?.url || "").toLowerCase();
    const t = `${item?.title || ""} ${item?.snippet || ""}`.toLowerCase();
    if (item?.signalType !== "demand") return true;
    if (item?.channel === "freelance_jobs") {
      const detailPath = /\/freelance-jobs\/(apply\/|technology-|[^/]+-\d+)/.test(u) || /\/projects\//.test(u);
      const commercialText = /(fixed-price|hourly|budget|\$\d|£\d|€\d|posted|proposals|hiring|looking for|we need|seeking)/.test(t);
      return detailPath && commercialText;
    }
    if (item?.channel === "github") return /\/issues\/\d+/.test(u);
    if (item?.channel === "reddit") return /\/comments\//.test(u) && /(hire|hiring|paid|budget|looking for someone|need someone|will pay)/.test(t);
    if (item?.channel === "public_rfp") return /(rfp|tender|procurement|solicitation|request for proposal|request for quote)/.test(t);
    return true;
  };
  for (const batch of batches) {
    if (batch.status !== "fulfilled") continue;
    for (const item of batch.value) {
      if (!item.url || seen.has(item.url) || !looksLikeListing(item)) continue;
      seen.add(item.url); results.push(item);
      if (results.length >= count) break;
    }
    if (results.length >= count) break;
  }
  return { enabled: true, provider, queries, results, strategy: techIntent ? "tech_individual_listing_demand_first" : "demand_first" };
}

export function evidencePromptBlock(evidence) {
  if (!evidence?.enabled) return "\nLIVE DISCOVERY: unavailable. Treat market claims as hypotheses requiring validation.";
  if (!evidence.results.length) return `\nLIVE DISCOVERY: ${evidence.provider} was queried but returned no usable evidence. Do not claim validation.`;
  const rows = evidence.results.map((x,i)=>`[${i+1}] [${x.channel || "web"} / ${x.signalType || "demand"}] ${x.title}\nURL: ${x.url}\nSnippet: ${x.snippet}`).join("\n\n");
  return `\nLIVE MARKET DISCOVERY (${evidence.provider}; DEMAND-FIRST). First identify concrete current buyer intent or a specific pain signal. For tech revenue work, individual listings/issues/posts are required for demand qualification; category pages, search pages, generic articles, tutorials, and trend pages are context only and must not qualify as a buyer opportunity. Do NOT choose a product/service merely because a generic article says the business model is viable. Only after a demand signal is identified should you propose a fulfillment path, and label supply/pricing as unverified until separately checked. These are extracted web chunks for grounding, but still verify claims from the linked source. Treat items marked supply_competition (including Fiverr) as evidence of available services, competition, packaging, or price anchors only — never as proof that a buyer currently wants to pay. Cite URLs next to claims and explicitly separate observed evidence from inference. Never invent a buyer, supplier, price, contact, sale, or revenue figure. If direct demand is weak, say so and give the next validation action instead of claiming validation.\n\n${rows}`;
}
