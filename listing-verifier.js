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

async function verifyGithubIssue(url, verifiedAt) {
  const match = String(url || "").match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/i);
  if (!match) return null;

  const [, owner, repo, number] = match;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "OracleStack/1.0-public-listing-verifier"
      }
    });
    if (response.status === 404 || response.status === 410) {
      return { status: "CLOSED", verifiedAt, httpStatus: response.status, reason: "github_issue_not_found" };
    }
    if (!response.ok) {
      return { status: response.status === 403 ? "INACCESSIBLE" : "UNKNOWN", verifiedAt, httpStatus: response.status, reason: "github_api_unavailable" };
    }

    const issue = await response.json();
    if (issue?.pull_request) {
      return { status: "UNKNOWN", verifiedAt, httpStatus: response.status, reason: "github_result_is_pull_request" };
    }

    const status = issue?.state === "open" ? "VERIFIED_OPEN" : "CLOSED";
    const labels = Array.isArray(issue?.labels)
      ? issue.labels.map(x => typeof x === "string" ? x : x?.name).filter(Boolean).slice(0, 8)
      : [];

    return {
      status,
      verifiedAt,
      httpStatus: response.status,
      finalUrl: issue?.html_url || url,
      evidence: `GitHub API reports issue state=${issue?.state || "unknown"}. Title: ${issue?.title || ""}. Labels: ${labels.join(", ") || "none"}.`
    };
  } catch (error) {
    return { status: error?.name === "AbortError" ? "INACCESSIBLE" : "UNKNOWN", verifiedAt, reason: String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

function statusFromPage(url, response, text) {
  const lower = text.toLowerCase();
  if (response.status === 404 || response.status === 410) return "CLOSED";
  if (!response.ok) return response.status === 401 || response.status === 403 ? "INACCESSIBLE" : "UNKNOWN";

  const closed = /(job is no longer available|project is no longer available|job has been closed|project has been closed|no longer accepting proposals|this job is closed|project closed|job filled|project completed|solicitation closed|bid period has closed|submission period has ended|deadline has passed)/i;
  const marketplaceOpen = /(submit a proposal|apply now|place a bid|bid on this project|send proposal|open for bidding|proposals?\s*[:(]|bids?\s*[:(])/i;
  const procurementOpen = /(request for proposal|request for quote|solicitation|invitation to bid|tender)/i.test(text)
    && /(deadline|due date|responses due|proposals due|bids due|closing date|submission date)/i.test(text);

  if (closed.test(text)) return "CLOSED";
  if (marketplaceOpen.test(text) || procurementOpen) return "VERIFIED_OPEN";
  if (/upwork\.com|freelancer\.com|peopleperhour\.com/i.test(url) && /(sign in|log in|access denied|captcha|verify you are human)/i.test(lower)) return "INACCESSIBLE";
  return "UNKNOWN";
}

export async function verifyListing(url) {
  const verifiedAt = new Date().toISOString();
  if (!/^https?:\/\//i.test(String(url || ""))) return { status: "UNKNOWN", verifiedAt, reason: "invalid_url" };
  const github = await verifyGithubIssue(url, verifiedAt);
  if (github) return github;
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
