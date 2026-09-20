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

export function buildAccessibleRescueSpecs(request = "") {
  const goal = compactGoal(request, 160) || "small business service";
  const broad = broadOpportunityIntent(request);
  const techIntent = /tech|software|saas|app|website|api|integration|automation|deploy|bug|code|data|ai|computer/i.test(goal);

  if (broad) {
    return [
      {
        channel: "github",
        signalType: "demand",
        q: 'site:github.com/*/*/issues/ (bounty OR "paid bounty" OR reward) (automation OR integration OR API OR website OR data) -closed'
      },
      {
        channel: "reddit",
        signalType: "demand",
        q: 'site:reddit.com/r/forhire/comments/ ("[Hiring]" OR hiring) (automation OR bookkeeping OR "video editor" OR Shopify OR WordPress) (budget OR paid OR "$")'
      },
      {
        channel: "public_rfp",
        signalType: "demand",
        q: '("request for proposal" OR "request for quote" OR solicitation) ("website redesign" OR "digital marketing" OR "video production") ("responses due" OR deadline OR "due date")'
      },
      {
        channel: "public_rfp",
        signalType: "demand",
        q: '("request for proposal" OR "request for quote" OR solicitation) (bookkeeping OR accounting OR automation OR "administrative services") ("responses due" OR deadline OR "due date")'
      }
    ];
  }

  if (techIntent) {
    return [
      {
        channel: "github",
        signalType: "demand",
        q: `site:github.com/*/*/issues/ (bounty OR "paid bounty" OR reward) ("${goal.slice(0, 100)}" OR automation OR API OR integration) -closed`
      },
      {
        channel: "reddit",
        signalType: "demand",
        q: `site:reddit.com/r/forhire/comments/ ("[Hiring]" OR hiring) ("${goal.slice(0, 100)}" OR automation OR API OR developer) (budget OR paid OR "$")`
      },
      {
        channel: "public_rfp",
        signalType: "demand",
        q: `("request for proposal" OR "request for quote" OR solicitation) ("${goal.slice(0, 100)}" OR software OR automation OR website) ("responses due" OR deadline OR "due date")`
      }
    ];
  }

  return [
    {
      channel: "reddit",
      signalType: "demand",
      q: `site:reddit.com/r/forhire/comments/ ("[Hiring]" OR hiring) "${goal.slice(0, 100)}" (budget OR paid OR "$")`
    },
    {
      channel: "public_rfp",
      signalType: "demand",
      q: `("request for proposal" OR "request for quote" OR solicitation) "${goal.slice(0, 100)}" ("responses due" OR deadline OR "due date")`
    }
  ];
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
    qualifyingDemandCount: 0,
    rescueTriggered: false
  };

  const plan = buildDiscoveryQuerySpecs(request);
  const provider = process.env.BRAVE_SEARCH_API_KEY ? "brave" : "serper";
  const search = provider === "brave" ? searchBrave : searchSerper;
  const seen = new Set();
  const collected = [];
  const queries = [];
  let rejectedCount = 0;

  async function collect(specs, perQuery) {
    if (!specs.length) return [];
    queries.push(...specs.map(x => x.q));
    const start = collected.length;
    const batches = await Promise.allSettled(
      specs.map(spec => search(spec.q, perQuery, spec.channel, spec.signalType))
    );
    for (const batch of batches) {
      if (batch.status !== "fulfilled") continue;
      for (const item of batch.value) {
        if (!item.url || seen.has(item.url)) continue;
        seen.add(item.url);
        if (!looksLikeListing(item)) {
          rejectedCount++;
          continue;
        }
        collected.push(item);
      }
    }
    return collected.slice(start);
  }

  async function enrich(items, verificationLimit) {
    const verified = await verifyListings(items, verificationLimit);
    const verificationByUrl = new Map(verified.map(x => [x.url, x.verification]));
    return items.map(x => {
      const item = { ...x, verification: verificationByUrl.get(x.url) || null };
      return { ...item, qualification: classifyDemandEvidence(item) };
    });
  }

  const primaryPerQuery = plan.broad ? 6 : plan.techIntent ? 8 : Math.max(4, Math.ceil(count / 2));
  const primaryRaw = await collect(plan.specs, primaryPerQuery);

  // Direct-demand sources first so the verification budget is not spent on context.
  primaryRaw.sort((a, b) => {
    const ad = a.signalType === "demand" && DIRECT_DEMAND_CHANNELS.has(a.channel) ? 1 : 0;
    const bd = b.signalType === "demand" && DIRECT_DEMAND_CHANNELS.has(b.channel) ? 1 : 0;
    return bd - ad;
  });

  const primarySelected = primaryRaw.slice(0, count);
  let enriched = await enrich(primarySelected, plan.broad ? 10 : plan.techIntent ? 8 : 6);
  let rescueTriggered = enriched.every(x => x.qualification !== "QUALIFIED");
  let rescueResultCount = 0;

  // Do not stop just because major marketplaces block direct verification.
  // Widen the scan automatically to sources that are more likely to be publicly verifiable.
  if (rescueTriggered) {
    const rescueSpecs = buildAccessibleRescueSpecs(request);
    const rescueRaw = await collect(rescueSpecs, 8);
    rescueResultCount = rescueRaw.length;
    const rescueEnriched = await enrich(rescueRaw, 12);
    enriched = [...enriched, ...rescueEnriched];
  }

  const qualificationRank = { QUALIFIED: 4, VERIFY: 3, CONTEXT_ONLY: 2, REJECTED: 1 };
  const sourceRank = { github: 4, public_rfp: 3, reddit: 3, freelancer: 2, peopleperhour: 2, upwork: 1 };
  enriched.sort((a, b) => {
    const q = (qualificationRank[b.qualification] || 0) - (qualificationRank[a.qualification] || 0);
    if (q) return q;
    return (sourceRank[b.channel] || 0) - (sourceRank[a.channel] || 0);
  });

  const finalResults = enriched.slice(0, count);
  const qualifyingDemandCount = finalResults.filter(x => x.qualification === "QUALIFIED").length;
  const verifyDemandCount = finalResults.filter(x => x.qualification === "VERIFY").length;

  return {
    enabled: true,
    provider,
    queries,
    results: finalResults,
    strategy: rescueTriggered ? `${plan.strategy}_accessible_rescue` : plan.strategy,
    rejectedCount,
    demandEvidenceCount: finalResults.filter(x => x.signalType === "demand").length,
    qualifyingDemandCount,
    verifyDemandCount,
    supplyEvidenceCount: finalResults.filter(x => x.signalType !== "demand").length,
    rescueTriggered,
    rescueResultCount
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
