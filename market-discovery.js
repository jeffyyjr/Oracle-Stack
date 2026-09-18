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

async function searchBrave(query, count) {
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
    source: "brave_llm_context"
  }));
}

async function searchSerper(query, count) {
  if (!process.env.SERPER_API_KEY) return [];
  const data = await fetchJson("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: count })
  });
  return (data?.organic || []).slice(0, count).map(item => ({ title: item.title, url: item.link, snippet: cleanText(item.snippet), source: "serper" }));
}

export function discoveryEnabled() {
  return Boolean(process.env.BRAVE_SEARCH_API_KEY || process.env.SERPER_API_KEY);
}

export async function discoverMarketEvidence(request, { count = 8 } = {}) {
  if (!discoveryEnabled()) return { enabled: false, provider: null, queries: [], results: [] };
  const goal = String(request).slice(0, 360);
  // Demand first: discover a concrete current need before researching fulfillment.
  const queries = [
    `${goal} ("looking for" OR "need help" OR "need a" OR "recommend" OR "request quote" OR "seeking") buyer customer`,
    `${goal} (problem OR complaint OR frustrated OR "can't find" OR "need someone") customer business`
  ];
  const provider = process.env.BRAVE_SEARCH_API_KEY ? "brave" : "serper";
  const search = provider === "brave" ? searchBrave : searchSerper;
  const batches = await Promise.allSettled(queries.map(q => search(q, Math.max(4, Math.ceil(count / 2)))));
  const seen = new Set(), results = [];
  for (const batch of batches) {
    if (batch.status !== "fulfilled") continue;
    for (const item of batch.value) {
      if (!item.url || seen.has(item.url)) continue;
      seen.add(item.url); results.push(item);
      if (results.length >= count) break;
    }
    if (results.length >= count) break;
  }
  return { enabled: true, provider, queries, results, strategy: "demand_first" };
}

export function evidencePromptBlock(evidence) {
  if (!evidence?.enabled) return "\nLIVE DISCOVERY: unavailable. Treat market claims as hypotheses requiring validation.";
  if (!evidence.results.length) return `\nLIVE DISCOVERY: ${evidence.provider} was queried but returned no usable evidence. Do not claim validation.`;
  const rows = evidence.results.map((x,i)=>`[${i+1}] ${x.title}\nURL: ${x.url}\nSnippet: ${x.snippet}`).join("\n\n");
  return `\nLIVE MARKET DISCOVERY (${evidence.provider}; DEMAND-FIRST). First identify concrete current buyer intent or a specific pain signal. Do NOT choose a product/service merely because a generic article says the business model is viable. Only after a demand signal is identified should you propose a fulfillment path, and label supply/pricing as unverified until separately checked. These are extracted web chunks for grounding, but still verify claims from the linked source. Cite URLs next to claims and explicitly separate observed evidence from inference. Never invent a buyer, supplier, price, contact, sale, or revenue figure. If direct demand is weak, say so and give the next validation action instead of claiming validation.\n\n${rows}`;
}
