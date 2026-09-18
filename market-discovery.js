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
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  const data = await fetchJson(url, { headers: { Accept: "application/json", "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY } });
  return (data?.web?.results || []).map(item => ({ title: item.title, url: item.url, snippet: cleanText(item.description), source: "brave" }));
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
  const queries = [
    `${request} buyer demand complaints alternatives pricing`,
    `${request} supplier wholesale service provider pricing`,
    `${request} people looking for recommendations request quote buy`
  ];
  const provider = process.env.BRAVE_SEARCH_API_KEY ? "brave" : "serper";
  const search = provider === "brave" ? searchBrave : searchSerper;
  const batches = await Promise.allSettled(queries.map(q => search(q, Math.max(3, Math.ceil(count / 2)))));
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
  return { enabled: true, provider, queries, results };
}

export function evidencePromptBlock(evidence) {
  if (!evidence?.enabled) return "\nLIVE DISCOVERY: unavailable. Treat market claims as hypotheses requiring validation.";
  if (!evidence.results.length) return `\nLIVE DISCOVERY: ${evidence.provider} was queried but returned no usable evidence. Do not claim validation.`;
  const rows = evidence.results.map((x,i)=>`[${i+1}] ${x.title}\nURL: ${x.url}\nSnippet: ${x.snippet}`).join("\n\n");
  return `\nLIVE MARKET DISCOVERY (${evidence.provider}). Search snippets are leads, not proof. Cite URLs next to claims and explicitly say what still needs verification. Never treat a search result as a buyer, supplier, price, or completed transaction without direct evidence.\n\n${rows}`;
}
