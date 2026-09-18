const VERIFY_TIMEOUT_MS = 10000;

function stripHtml(html = "") {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function statusFromPage(url, response, text) {
  const lower = text.toLowerCase();
  if (response.status === 404 || response.status === 410) return "CLOSED";
  if (!response.ok) return response.status === 401 || response.status === 403 ? "INACCESSIBLE" : "UNKNOWN";

  const closed = /(job is no longer available|project is no longer available|job has been closed|project has been closed|no longer accepting proposals|this job is closed|project closed|job filled|project completed)/i;
  const open = /(submit a proposal|apply now|place a bid|bid on this project|send proposal|open for bidding|proposals?\s*[:(]|bids?\s*[:(])/i;

  if (closed.test(text)) return "CLOSED";
  if (open.test(text)) return "VERIFIED_OPEN";
  if (/upwork\.com|freelancer\.com|peopleperhour\.com/i.test(url) && /(sign in|log in|access denied|captcha|verify you are human)/i.test(lower)) return "INACCESSIBLE";
  return "UNKNOWN";
}

export async function verifyListing(url) {
  const verifiedAt = new Date().toISOString();
  if (!/^https?:\/\//i.test(String(url || ""))) return { status: "UNKNOWN", verifiedAt, reason: "invalid_url" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; OracleStack/1.0; public-listing-verifier)" }
    });
    const html = await response.text();
    const text = stripHtml(html).slice(0, 24000);
    return {
      status: statusFromPage(url, response, text),
      verifiedAt,
      httpStatus: response.status,
      finalUrl: response.url,
      evidence: text.slice(0, 5000)
    };
  } catch (error) {
    return { status: error?.name === "AbortError" ? "INACCESSIBLE" : "UNKNOWN", verifiedAt, reason: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyListings(items = [], limit = 5) {
  const targets = items.filter(x => x?.url && x?.signalType === "demand").slice(0, limit);
  const settled = await Promise.allSettled(targets.map(async item => ({ ...item, verification: await verifyListing(item.url) })));
  return settled.filter(x => x.status === "fulfilled").map(x => x.value);
}
