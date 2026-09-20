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
  if (channel !== "business_web") url.searchParams.set("freshness", "pm");
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

function campaignField(request = "", label = "") {
  const match = String(request).match(new RegExp("(?:^|\\n)" + label + ":\\s*([^\\n]+)", "i"));
  return match ? cleanText(match[1]).slice(0, 220) : "";
}

const QUERY_STOP = new Set(["with","that","this","from","your","their","business","businesses","service","services","similar","home","using","into","through","about","only","currently","real","help","automation"]);
function searchTermGroup(value = "", max = 8) {
  const terms = compactGoal(value, 260).toLowerCase().split(/\s+/)
    .map(x => x.replace(/^-+|-+$/g,""))
    .filter(x => x.length >= 4 && !QUERY_STOP.has(x))
    .slice(0, max);
  return terms.length ? "(" + terms.map(x => /^[a-z0-9+#.-]+$/i.test(x) ? x : `"${x}"`).join(" OR ") + ")" : "";
}


const HOME_SERVICE_VERTICALS = [
  ["hvac", /\b(hvac|heating|cooling|air conditioning)\b/i],
  ["plumbing", /\b(plumb(?:er|ing)?)\b/i],
  ["electrical", /\b(electric(?:al|ian)?)\b/i],
  ["roofing", /\b(roof(?:er|ing)?)\b/i],
  ["landscaping", /\b(landscap(?:e|er|ing)?)\b/i],
  ["garage door", /\bgarage door\b/i],
  ["pest control", /\bpest control\b/i],
  ["tree service", /\btree service\b/i],
  ["remodeling", /\bremodel(?:er|ing)?\b/i]
];

function homeServiceVerticals(value = "") {
  const found = HOME_SERVICE_VERTICALS.filter(([,rx]) => rx.test(String(value))).map(([name]) => name);
  return found.length ? found : (/home[- ]service|contractor/i.test(String(value)) ? ["hvac","plumbing","electrical","roofing","landscaping"] : []);
}

function publicWebsiteUrl(raw = "") {
  try {
    const u = new URL(String(raw));
    if (!["http:","https:"].includes(u.protocol)) return null;
    const h = u.hostname.toLowerCase();
    if (!h || h === "localhost" || h.endsWith(".local") || h === "::1" || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return null;
    return u;
  } catch { return null; }
}

function baseHost(hostname = "") {
  return String(hostname).toLowerCase().replace(/^www\./,"");
}

function extractPublicRoleEmail(html = "", hostname = "") {
  const host = baseHost(hostname);
  const decoded = String(html).replace(/&#64;|&#x40;/gi,"@").replace(/&#46;|&#x2e;/gi,".");
  const matches = [...new Set(decoded.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])].map(x=>x.toLowerCase());
  const priority = {
    servicerequest:120, service:115, appointments:110, appointment:110, booking:108,
    estimates:106, estimate:106, quotes:104, quote:104, clientcare:102, customerservice:100,
    office:90, contact:88, hello:84, support:82, info:78, sales:74, admin:60
  };
  const blockedContext = /(vendor|supplier|procurement|careers?|jobs?|employment|press|media|marketing|advertis|partnership|affiliate|billing|accounts payable|accounts receivable)/i;
  const preferredContext = /(service request|schedule|appointment|book|estimate|quote|customer|client|support|contact us|call us|request service)/i;
  const candidates=[];

  for (const raw of matches) {
    const [local,domain] = raw.split("@");
    if (!local || !domain) continue;
    const d=baseHost(domain);
    if (!(d===host || d.endsWith("." + host) || host.endsWith("." + d))) continue;
    const key=local.replace(/[._-]/g,"").toLowerCase();
    if (!(key in priority)) continue;

    let score=priority[key];
    const idx=decoded.toLowerCase().indexOf(raw);
    const context=idx>=0 ? cleanText(decoded.slice(Math.max(0,idx-220),Math.min(decoded.length,idx+raw.length+220))) : "";
    if (blockedContext.test(context)) score-=100;
    if (preferredContext.test(context)) score+=18;
    candidates.push({email:raw.slice(0,320),role:key,score,context:context.slice(0,420)});
  }

  candidates.sort((a,b)=>b.score-a.score);
  const best=candidates.find(x=>x.score>=70);
  return best || null;
}

function decodeHtmlText(value = "") {
  return cleanText(String(value)
    .replace(/&amp;/gi,"&")
    .replace(/&quot;/gi,'"')
    .replace(/&#39;|&apos;/gi,"'")
    .replace(/&nbsp;/gi," "));
}

function extractBusinessName(html = "", seedTitle = "", hostname = "") {
  const raw=String(html), candidates=[];
  const siteName=raw.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)
    || raw.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);
  if(siteName?.[1]) candidates.push(decodeHtmlText(siteName[1]));
  const appName=raw.match(/<meta[^>]+name=["']application-name["'][^>]+content=["']([^"']+)["']/i);
  if(appName?.[1]) candidates.push(decodeHtmlText(appName[1]));
  const title=raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if(title) {
    const decoded=decodeHtmlText(title);
    candidates.push(...decoded.split(/\s+[|–—-]\s+/).map(x=>x.trim()));
    candidates.push(decoded);
  }
  candidates.push(decodeHtmlText(seedTitle));

  const generic=/^(contact(?: us)?|schedule(?: service)?|book(?: service| now)?|free (?:hvac )?estimates?|request (?:service|a quote|an estimate)|home|services?|hvac services?|plumbing services?|roofing services?|commercial & residential roofing services)$/i;
  const hostLabel=baseHost(hostname).split(".")[0].replace(/[^a-z0-9]/gi,"").toLowerCase();
  const scoreCandidate=(candidate)=>{
    const c=cleanText(candidate).replace(/^[-|:]+|[-|:]+$/g,"").trim();
    if(c.length<2||c.length>90||generic.test(c)) return null;
    const norm=c.replace(/[^a-z0-9]/gi,"").toLowerCase();
    const words=c.match(/[A-Za-z0-9]+/g)||[];
    const acronym=words.map(w=>w[0]).join("").toLowerCase();
    let score=0;
    if(hostLabel.length>=4 && (norm.includes(hostLabel)||hostLabel.includes(norm))) score+=120;
    if(hostLabel.length>=2 && acronym===hostLabel) score+=110;
    if(/roof|plumb|hvac|heat|cool|electric|landscap|residential|service/i.test(c)) score+=15;
    if(/^(contact|free|schedule|commercial|residential|las vegas|central florida)/i.test(c)) score-=25;
    if(siteName?.[1] && c===decodeHtmlText(siteName[1])) score+=30;
    return {c,score};
  };
  const ranked=candidates.map(scoreCandidate).filter(Boolean).sort((a,b)=>b.score-a.score);
  if(ranked.length && ranked[0].score>0) return ranked[0].c;
  const fallback=ranked.find(x=>/[a-z]/i.test(x.c));
  if(fallback) return fallback.c;
  const label=baseHost(hostname).split(".")[0]||"Business";
  return label.split(/[-_]+/).filter(Boolean).map(x=>x.charAt(0).toUpperCase()+x.slice(1)).join(" ");
}

function visiblePageText(html = "") {
  return cleanText(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi," "))
    .slice(0,50000);
}

function prospectFitSignals(text = "") {
  const t=String(text).toLowerCase(), out=[];
  if (/request (?:service|an estimate|a quote)|schedule (?:service|an appointment)|book (?:online|now|service)/i.test(t)) out.push("service_request_cta");
  if (/24\s*\/\s*7|24-hour|24 hour|emergency service|same[- ]day service/i.test(t)) out.push("urgent_lead_flow");
  if (/financing|payment plans?|special offers?|coupons?/i.test(t)) out.push("sales_conversion_flow");
  if (/service areas?|areas we serve|locations|multiple locations/i.test(t)) out.push("multi_area_operations");
  if (/residential.+commercial|commercial.+residential/i.test(t)) out.push("multi_segment_operations");
  if (/call (?:now|today)|phone|tel:/i.test(t)) out.push("phone_lead_cta");
  if (/contact form|name.+email.+phone|send message/i.test(t)) out.push("web_lead_form");
  return [...new Set(out)];
}

function contactLinks(html = "", baseUrl = "") {
  const links=[]; const rx=/href\s*=\s*["']([^"'#]+)["']/gi; let m;
  const base=publicWebsiteUrl(baseUrl); if(!base) return [];
  const host=baseHost(base.hostname);
  while((m=rx.exec(String(html)))) {
    if(!/(contact|schedule|book|request|estimate|quote)/i.test(m[1])) continue;
    try {
      const u=publicWebsiteUrl(new URL(m[1],base.href).href);
      if(u && baseHost(u.hostname)===host) links.push(u.href);
    } catch {}
  }
  return [...new Set(links)].slice(0,2);
}

async function fetchPublicHtml(url, timeoutMs = 8000) {
  let safe=publicWebsiteUrl(url); if(!safe) return null;
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try {
    for(let redirectCount=0;redirectCount<4;redirectCount++) {
      const r=await fetch(safe.href,{signal:controller.signal,redirect:"manual",headers:{"User-Agent":"Oracle-Stack-Prospect-Research/1.0","Accept":"text/html,application/xhtml+xml"}});
      if([301,302,303,307,308].includes(r.status)) {
        const location=r.headers.get("location"); if(!location) return null;
        const next=publicWebsiteUrl(new URL(location,safe.href).href); if(!next) return null;
        safe=next; continue;
      }
      if(!r.ok) return null;
      const type=String(r.headers.get("content-type")||"");
      if(!type.includes("text/html")) return null;
      return {url:safe.href,html:(await r.text()).slice(0,350000)};
    }
    return null;
  } catch { return null; } finally { clearTimeout(timer); }
}

async function inspectBusinessProspect(seed = {}, verticals = []) {
  const safe=publicWebsiteUrl(seed.url); if(!safe) return null;
  const host=baseHost(safe.hostname);
  if(/(yelp|angi|homeadvisor|thumbtack|bbb|facebook|linkedin|mapquest|yellowpages|forbes|wikipedia|reddit)\./i.test(host)) return null;

  const first=await fetchPublicHtml(seed.url,4500); if(!first) return null;
  const firstUrl=new URL(first.url);
  const home=firstUrl.pathname!=="/" ? await fetchPublicHtml(firstUrl.origin+"/",4500) : null;
  let html=first.html, pageText=visiblePageText(html);
  const combined=`${seed.title} ${seed.snippet} ${pageText.slice(0,12000)}`;
  const vertical=verticals.find(v => new RegExp(v.replace(/\s+/g,"\\s+"),"i").test(combined));
  if(!vertical) return null;

  let contact=extractPublicRoleEmail(html,new URL(first.url).hostname);
  if(!contact) {
    const links=contactLinks(html,first.url);
    const pages=await Promise.allSettled(links.map(link=>fetchPublicHtml(link,4500)));
    for(const result of pages) {
      if(result.status!=="fulfilled" || !result.value) continue;
      const page=result.value;
      pageText += " " + visiblePageText(page.html);
      contact=extractPublicRoleEmail(page.html,new URL(page.url).hostname) || contact;
      if(contact) break;
    }
  }

  const email=contact?.email || null;
  const signals=prospectFitSignals(pageText);
  const verified=Boolean(email && signals.length>=1);
  const brandHtml=home?.html||first.html;
  const businessName=extractBusinessName(brandHtml,seed.title,firstUrl.hostname).slice(0,180);
  const score=Math.min(92,55 + (email?15:0) + Math.min(20,signals.length*5) + (signals.includes("urgent_lead_flow")?5:0));
  return {
    ...seed,
    title:businessName,
    url:first.url,
    source:"business_website",
    channel:"business_web",
    signalType:"prospect",
    buyerEmail:email,
    buyerEmailRole:contact?.role || null,
    buyerEmailContext:contact?.context || null,
    fitSignals:signals,
    prospecting:true,
    prospectScore:score,
    snippet:`Verified public business website for ${vertical}. Observable fit signals: ${signals.length?signals.join(", "):"none"}. Public contact role: ${contact?.role || "none"}. No explicit purchase request was found.`,
    verification:{status:verified?"VERIFIED_OPEN":"VERIFY",checkedAt:new Date().toISOString(),method:"public_business_website"},
    qualification:verified?"PROSPECT_QUALIFIED":"PROSPECT_VERIFY"
  };
}

async function enrichBusinessProspects(items = [], verticals = [], limit = 12) {
  const seeds=[]; const seenHosts=new Set();
  for(const seed of items) {
    const safe=publicWebsiteUrl(seed.url); if(!safe) continue;
    const host=baseHost(safe.hostname);
    if(seenHosts.has(host)) continue;
    seenHosts.add(host); seeds.push(seed);
    if(seeds.length>=Math.max(limit+6,18)) break;
  }

  const out=[]; let cursor=0;
  const worker=async()=>{
    while(cursor<seeds.length && out.length<limit) {
      const seed=seeds[cursor++];
      const prospect=await inspectBusinessProspect(seed,verticals);
      if(prospect) out.push(prospect);
    }
  };
  await Promise.all(Array.from({length:Math.min(6,seeds.length)},()=>worker()));
  return out.slice(0,limit);
}

export function buildDiscoveryQuerySpecs(request = "") {
  const goal = compactGoal(request, 220);
  const techTerms = "API integration automation SaaS AWS deployment backend database AI workflow bug fix";
  const techIntent = /tech|software|saas|app|website|api|integration|automation|deploy|bug|code|data|ai|computer/i.test(goal);
  const targetBuyer = campaignField(request, "Target buyer");
  const offer = campaignField(request, "Offer");
  const campaignSpecific = Boolean(targetBuyer || offer);
  const broad = !campaignSpecific && broadOpportunityIntent(request);

  const campaignVerticals = homeServiceVerticals(`${targetBuyer} ${offer} ${goal}`);
  if (campaignSpecific && campaignVerticals.length) {
    const verticals=campaignVerticals;
    return {
      techIntent:false,
      broad:false,
      campaignSpecific:true,
      prospecting:true,
      verticals,
      strategy:"home_service_business_prospecting",
      specs: verticals.slice(0,5).map(vertical => ({
        channel:"business_web",
        signalType:"prospect",
        q:`"${vertical}" company ("request service" OR "schedule service" OR "24/7" OR financing OR "areas we serve") ("contact us" OR contact OR schedule) -site:yelp.com -site:angi.com -site:homeadvisor.com -site:thumbtack.com -site:bbb.org -site:facebook.com -site:linkedin.com`
      }))
    };
  }

  if (campaignSpecific) {
    const buyer = targetBuyer || "small business";
    const solution = offer || goal || "automation service";
    const buyerGroup = searchTermGroup(buyer, 8) || "(contractor OR hvac OR plumbing OR roofing OR electrical)";
    const solutionGroup = searchTermGroup(solution, 10) || "(automation OR booking OR crm OR leads)";
    const focused = `${buyerGroup} ${solutionGroup}`;
    return {
      techIntent,
      broad: false,
      campaignSpecific: true,
      strategy: "campaign_specific_buyer_demand",
      specs: [
        {
          channel: "upwork",
          signalType: "demand",
          q: `site:upwork.com/freelance-jobs/apply/ ${buyerGroup} ${solutionGroup} (CRM OR booking OR leads OR "follow up" OR "missed calls") ("Fixed Price" OR hourly OR budget) -academic -homework`
        },
        {
          channel: "freelancer",
          signalType: "demand",
          q: `site:freelancer.com/projects/ ${buyerGroup} ${solutionGroup} (CRM OR booking OR leads OR follow-up) (budget OR fixed OR hourly) -academic -homework`
        },
        {
          channel: "reddit",
          signalType: "demand",
          q: `(site:reddit.com/r/forhire/comments/ OR site:reddit.com/r/smallbusiness/comments/) ${buyerGroup} ${solutionGroup} (hiring OR "need help" OR "looking for" OR budget OR paid)`
        },
        {
          channel: "public_rfp",
          signalType: "demand",
          q: `("request for proposal" OR RFP OR solicitation OR "request for quote") ${buyerGroup} ${solutionGroup} (CRM OR booking OR lead) (deadline OR due)`
        },
        {
          channel: "web_demand",
          signalType: "context",
          q: `${focused} ("looking for" OR "need help" OR "seeking" OR hiring) (CRM OR booking OR leads OR follow-up)`
        }
      ]
    };
  }

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
  const targetBuyer = campaignField(request, "Target buyer");
  const offer = campaignField(request, "Offer");
  const broad = !targetBuyer && !offer && broadOpportunityIntent(request);
  const techIntent = /tech|software|saas|app|website|api|integration|automation|deploy|bug|code|data|ai|computer/i.test(goal);

  if (targetBuyer || offer) {
    const buyerGroup = searchTermGroup(targetBuyer || "small business", 8) || "(contractor OR hvac OR plumbing OR roofing OR electrical)";
    const solutionGroup = searchTermGroup(offer || goal, 10) || "(automation OR booking OR crm OR leads)";
    return [
      {
        channel: "reddit",
        signalType: "demand",
        q: `site:reddit.com/r/forhire/comments/ ${buyerGroup} ${solutionGroup} (hiring OR paid OR budget OR "need help")`
      },
      {
        channel: "public_rfp",
        signalType: "demand",
        q: `("request for proposal" OR "request for quote" OR solicitation) ${buyerGroup} ${solutionGroup} (deadline OR "due date")`
      }
    ];
  }

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

  if (item?.channel === "github") return /\/issues\/\d+/.test(u) && /(bounty|paid bounty|paid task|reward|sponsor|compensation|\$\s?\d)/.test(t);
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

  if (plan.prospecting) {
    const raw=await collect(plan.specs,6);
    const prospects=await enrichBusinessProspects(raw,plan.verticals||[],Math.max(count,12));
    prospects.sort((a,b)=>(b.prospectScore||0)-(a.prospectScore||0));
    const finalResults=prospects.slice(0,count);
    return {
      enabled:true,
      provider,
      strategy:plan.strategy,
      prospecting:true,
      queries,
      results:finalResults,
      qualifyingDemandCount:finalResults.filter(x=>x.qualification==="PROSPECT_QUALIFIED").length,
      verifyDemandCount:finalResults.filter(x=>x.qualification==="PROSPECT_VERIFY").length,
      rejectedCount,
      rescueTriggered:false,
      rescueResultCount:0
    };
  }

  async function enrich(items, verificationLimit) {
    const verified = await verifyListings(items, verificationLimit);
    const verificationByUrl = new Map(verified.map(x => [x.url, x.verification]));
    return items.map(x => {
      const item = { ...x, verification: verificationByUrl.get(x.url) || null };
      return { ...item, qualification: classifyDemandEvidence(item) };
    });
  }

  const primaryPerQuery = plan.campaignSpecific ? 8 : plan.broad ? 6 : plan.techIntent ? 8 : Math.max(4, Math.ceil(count / 2));
  const primaryRaw = await collect(plan.specs, primaryPerQuery);

  // Direct-demand sources first so the verification budget is not spent on context.
  primaryRaw.sort((a, b) => {
    const ad = a.signalType === "demand" && DIRECT_DEMAND_CHANNELS.has(a.channel) ? 1 : 0;
    const bd = b.signalType === "demand" && DIRECT_DEMAND_CHANNELS.has(b.channel) ? 1 : 0;
    return bd - ad;
  });

  const primarySelected = primaryRaw.slice(0, count);
  let enriched = await enrich(primarySelected, plan.campaignSpecific ? 12 : plan.broad ? 10 : plan.techIntent ? 8 : 6);
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
