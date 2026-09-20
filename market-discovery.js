import { verifyListings } from "./listing-verifier.js";
const DEFAULT_TIMEOUT_MS = 12000;

const DIRECT_DEMAND_CHANNELS = new Set([
  "upwork",
  "freelancer",
  "peopleperhour",
  "reddit",
  "github",
  "public_rfp"
]);

function cleanText(value = "") {
  return String(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function compactGoal(request = "", max = 180) {
  return String(request)
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[^a-z0-9$+.#\-\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function broadOpportunityIntent(request = "") {
  return /(?:find|show|give|hunt|discover).{0,45}(?:something|opportunit|service|product).{0,55}(?:sell|make money|income)|without holding inventory|no inventory|side\s*hustle|business idea|what can i sell|something legitimate i can sell|automatic sales force/i.test(String(request));
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
  return (data?.organic || []).slice(0, count).map(item => ({
    title: item.title,
    url: item.link,
    snippet: cleanText(item.snippet),
    source: "serper",
    channel,
    signalType
  }));
}

export function discoveryEnabled() {
  return Boolean(process.env.BRAVE_SEARCH_API_KEY || process.env.SERPER_API_KEY);
}

export function buildDiscoveryQuerySpecs(request = "") {
  const goal = compactGoal(request, 220);
  const techTerms = "API integration automation SaaS AWS deployment backend database AI workflow bug fix";
  const techIntent = /tech|software|saas|app|website|api|integration|automation|deploy|bug|code|data|ai|computer/i.test(goal);
  const broad = broadOpportunityIntent(request);

  if (broad) {
    // Broad opportunity scans must start from real buyers, not "best side hustle" articles.
    // Probe several inventory-free service categories so Oracle can compare actual demand signals.
    return {
      techIntent,
      broad,
      strategy: "broad_inventory_free_buyer_radar",
      specs: [
        {
          channel: "upwork",
          signalType: "demand",
          q: 'site:upwork.com/freelance-jobs/apply/ ("bookkeeping" OR "QuickBooks cleanup" OR "monthly bookkeeping") ("Fixed Price" OR hourly OR budget) -academic -homework'
        },
        {
          channel: "upwork",
          signalType: "demand",
          q: 'site:upwork.com/freelance-jobs/apply/ ("appointment setting" OR "lead generation" OR "CRM follow up" OR "sales automation") ("Fixed Price" OR hourly OR budget) -academic -homework'
        },
        {
          channel: "upwork",
          signalType: "demand",
          q: 'site:upwork.com/freelance-jobs/apply/ ("video editing" OR "short form video" OR "content repurposing") ("Fixed Price" OR hourly OR budget) -academic -homework'
        },
        {
          channel: "upwork",
          signalType: "demand",
          q: 'site:upwork.com/freelance-jobs/apply/ ("WordPress" OR Shopify OR Zapier OR automation OR "website fix") ("Fixed Price" OR hourly OR budget) -academic -homework'
        },
        {
          channel: "freelancer",
          signalType: "demand",
          q: 'site:freelancer.com/projects/ ("bookkeeping" OR "virtual assistant" OR "video editing" OR WordPress OR automation) (budget OR fixed OR hourly) -academic -homework'
        },
        {
          channel: "peopleperhour",
          signalType: "demand",
          q: 'site:peopleperhour.com/freelance-jobs/ ("bookkeeping" OR "lead generation" OR "video editing" OR WordPress OR automation) (budget OR fixed OR hourly) -academic -homework'
        }
      ]
    };
  }

  if (techIntent) {
    return {
      techIntent,
      broad,
      strategy: "tech_individual_listing_demand_first",
      specs: [
        { channel: "upwork", signalType: "demand", q: `site:upwork.com/freelance-jobs/apply/ ("API" OR automation OR AWS OR SaaS OR backend) ("Fixed Price" OR hourly OR budget) -academic -homework` },
        { channel: "freelancer", signalType: "demand", q: `site:freelancer.com/projects/ ("API" OR automation OR AWS OR backend OR integration) (budget OR fixed OR hourly) -academic -homework` },
        { channel: "peopleperhour", signalType: "demand", q: `site:peopleperhour.com/freelance-jobs/ ("API" OR automation OR SaaS OR integration OR bug) (budget OR fixed OR hourly) -academic -homework` },
        { channel: "reddit", signalType: "demand", q: `site:reddit.com/r/forhire OR site:reddit.com/r/freelance ("[Hiring]" OR "will pay" OR budget) (${techTerms})` },
        { channel: "github", signalType: "demand", q: `site:github.com/issues (bounty OR "$" OR "paid" OR sponsor) (${techTerms})` },
        { channel: "public_rfp", signalType: "demand", q: `("request for proposal" OR RFP OR solicitation OR "request for quote") (${techTerms}) (deadline OR due)` }
      ]
    };
  }

  const specific = goal || "small business service";
  return {
    techIntent,
    broad,
    strategy: "specific_service_demand_first",
    specs: [
      {
        channel: "upwork",
        signalType: "demand",
        q: `site:upwork.com/freelance-jobs/apply/ "${specific.slice(0, 120)}" ("Fixed Price" OR hourly OR budget) -academic -homework`
      },
      {
        channel: "freelancer",
        signalType: "demand",
        q: `site:freelancer.com/projects/ "${specific.slice(0, 120)}" (budget OR fixed OR hourly) -academic -homework`
      },
      {
        channel: "web_demand",
        signalType: "context",
        q: `${specific} ("looking for" OR "need help" OR "need a" OR "request quote" OR "seeking") buyer customer`
      },
      {
        channel: "web_pain",
        signalType: "context",
        q: `${specific} (problem OR complaint OR frustrated OR "can't find" OR "need someone") customer business`
      }
    ]
  };
}

function looksLikeListing(item) {
  const u = String(item?.url || "").toLowerCase();
  const t = `${item?.title || ""} ${item?.snippet || ""}`.toLowerCase();
  if (item?.signalType !== "demand") return true;

  if (["upwork", "freelancer", "peopleperhour"].includes(item?.channel)) {
    const detailPath =
      /upwork\.com\/freelance-jobs\/apply\//.test(u) ||
      /freelancer\.com\/projects\//.test(u) ||
      /peopleperhour\.com\/freelance-jobs\//.test(u);
    const commercialText = /(fixed-price|fixed price|hourly|budget|\$\s?\d|£\s?\d|€\s?\d|posted|proposals|hiring|looking for|we need|seeking)/.test(t);
    const academicRisk = /(homework|school assignment|college assignment|university assignment|coursework|exam help)/.test(t);
    return detailPath && commercialText && !academicRisk;
  }

  if (item?.channel === "github") return /\/issues\/\d+/.test(u);
  if (item?.channel === "reddit") return /\/comments\//.test(u) && /(hire|hiring|paid|budget|looking for someone|need someone|will pay)/.test(t);
  if (item?.channel === "public_rfp") return /(rfp|tender|procurement|solicitation|request for proposal|request for quote)/.test(t);
  return false;
}

export function classifyDemandEvidence(item) {
  if (!item || item.signalType !== "demand") return "CONTEXT_ONLY";
  if (!DIRECT_DEMAND_CHANNELS.has(item.channel)) return "CONTEXT_ONLY";

  const status = item.verification?.status || "NOT_CHECKED";
  if (status === "VERIFIED_OPEN") return "QUALIFIED";
  if (status === "CLOSED") return "REJECTED";
  return "VERIFY";
}

export async function discoverMarketEvidence(request, { count = 14 } = {}) {
  if (!discoveryEnabled()) return {
    enabled: false,
    provider: null,
    queries: [],
    results: [],
    qualifyingDemandCount: 0
  };

  const plan = buildDiscoveryQuerySpecs(request);
  const querySpecs = plan.specs;
  const queries = querySpecs.map(x => x.q);
  const provider = process.env.BRAVE_SEARCH_API_KEY ? "brave" : "serper";
  const search = provider === "brave" ? searchBrave : searchSerper;
  const perQuery = plan.broad ? 6 : plan.techIntent ? 8 : Math.max(4, Math.ceil(count / 2));

  const batches = await Promise.allSettled(
    querySpecs.map(spec => search(spec.q, perQuery, spec.channel, spec.signalType))
  );

  const seen = new Set();
  const results = [];
  const rejected = [];

  for (const batch of batches) {
    if (batch.status !== "fulfilled") continue;
    for (const item of batch.value) {
      if (!item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      if (!looksLikeListing(item)) {
        rejected.push(item);
        continue;
      }
      results.push(item);
    }
  }

  // Keep direct demand ahead of context so verification budget goes to actual buyers.
  results.sort((a, b) => {
    const ad = a.signalType === "demand" && DIRECT_DEMAND_CHANNELS.has(a.channel) ? 1 : 0;
    const bd = b.signalType === "demand" && DIRECT_DEMAND_CHANNELS.has(b.channel) ? 1 : 0;
    return bd - ad;
  });

  const selected = results.slice(0, count);
  const verified = await verifyListings(selected, plan.broad ? 10 : plan.techIntent ? 8 : 6);
  const verificationByUrl = new Map(verified.map(x => [x.url, x.verification]));
  const enriched = selected.map(x => {
    const item = { ...x, verification: verificationByUrl.get(x.url) || null };
    return { ...item, qualification: classifyDemandEvidence(item) };
  });

  const qualifyingDemandCount = enriched.filter(x => x.qualification === "QUALIFIED").length;
  const verifyDemandCount = enriched.filter(x => x.qualification === "VERIFY").length;

  return {
    enabled: true,
    provider,
    queries,
    results: enriched,
    strategy: plan.strategy,
    rejectedCount: rejected.length,
    demandEvidenceCount: enriched.filter(x => x.signalType === "demand").length,
    qualifyingDemandCount,
    verifyDemandCount,
    supplyEvidenceCount: enriched.filter(x => x.signalType !== "demand").length
  };
}

export function evidencePromptBlock(evidence) {
  if (!evidence?.enabled) {
    return "\nLIVE DISCOVERY: unavailable. Treat market claims as hypotheses requiring validation.";
  }
  if (!evidence.results.length) {
    return `\nLIVE DISCOVERY: ${evidence.provider} was queried but returned no usable buyer evidence. Do not claim validation or select a winner. Report that no qualified live opportunity was found this run and state the next scan/validation action.`;
  }

  const rows = evidence.results.map((x, i) =>
    `[${i + 1}] [${x.channel || "web"} / ${x.signalType || "demand"} / ${x.qualification || "CONTEXT_ONLY"}] ${x.title}\nURL: ${x.url}\nVerification: ${x.verification?.status || "NOT_CHECKED"} at ${x.verification?.verifiedAt || "n/a"} (HTTP ${x.verification?.httpStatus ?? "n/a"})\nSnippet: ${x.snippet}\nLive page evidence: ${x.verification?.evidence || "unavailable"}`
  ).join("\n\n");

  const gate = Number(evidence.qualifyingDemandCount || 0) > 0
    ? `QUALIFICATION GATE: ${evidence.qualifyingDemandCount} direct buyer signal(s) are VERIFIED_OPEN. Prefer opportunities backed by those QUALIFIED items. A specific buyer/listing URL must be cited for any claim that demand is validated.`
    : "QUALIFICATION GATE: ZERO direct buyer signals were VERIFIED_OPEN. You MUST NOT say demand is validated, MUST NOT present an article-derived business idea as the selected opportunity, and MUST NOT imply that a buyer has been found. You may name hypotheses for the next scan, but the run result is NO QUALIFIED OPPORTUNITY FOUND.";

  return `
LIVE MARKET DISCOVERY (${evidence.provider}; ${evidence.strategy || "demand_first"}).
${gate}

Rules:
- Buyer evidence outranks business-model articles, tutorials, trend posts, category pages, and generic search results.
- QUALIFIED means an individual direct-demand item was best-effort verified as currently open.
- VERIFY means the item may be relevant but could not be confirmed open; it cannot support a "validated demand" claim.
- REJECTED/CLOSED items cannot be used.
- CONTEXT_ONLY items may explain a market but cannot prove willingness to pay.
- Only after a qualified demand signal is identified should you propose fulfillment and pricing, and those must remain labeled assumptions until independently checked.
- Never invent a buyer, supplier, budget, contact, sale, revenue figure, credential, or platform access.
- Never bypass login walls, CAPTCHAs, access controls, or platform protections.
- For a broad "find me something to sell" request, compare qualified buyer signals across categories and choose based on concrete demand evidence, not generic plausibility.
- If there are no QUALIFIED signals, say so plainly and give the next automated scan/validation action instead of forcing a recommendation.
- Cite URLs next to every buyer-demand claim and separate observed evidence from inference.

${rows}`;
}
