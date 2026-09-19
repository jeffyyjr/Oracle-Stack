import crypto from "crypto";

function parseQuotaMap() {
  const raw = String(process.env.ORACLE_API_QUOTAS || "").trim();
  const map = new Map();
  if (!raw) return map;
  for (const entry of raw.split(",").map(v => v.trim()).filter(Boolean)) {
    const split = entry.indexOf("=");
    if (split <= 0) continue;
    const id = entry.slice(0, split).trim();
    const limit = Number(entry.slice(split + 1).trim());
    if (id && Number.isFinite(limit) && limit > 0) map.set(id, Math.floor(limit));
  }
  return map;
}

const QUOTAS = parseQuotaMap();
const DEFAULT_QUOTA = Number.isFinite(Number(process.env.ORACLE_API_DEFAULT_QUOTA))
  ? Math.max(1, Math.floor(Number(process.env.ORACLE_API_DEFAULT_QUOTA)))
  : 500;
const usage = new Map();

function currentWindow() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function parseKeys() {
  const raw = String(process.env.ORACLE_API_KEYS || "").trim();
  if (!raw) return [];
  return raw.split(",").map(entry => entry.trim()).filter(Boolean).map(entry => {
    const split = entry.indexOf(":");
    if (split <= 0) return null;
    const id = entry.slice(0, split).trim();
    const secret = entry.slice(split + 1).trim();
    if (!id || !secret) return null;
    return {
      id,
      secretHash: crypto.createHash("sha256").update(secret).digest(),
      quota: QUOTAS.get(id) || DEFAULT_QUOTA
    };
  }).filter(Boolean);
}

const API_KEYS = parseKeys();

export function apiAuthEnabled() {
  return API_KEYS.length > 0;
}

function safeMatch(secret, expectedHash) {
  const actual = crypto.createHash("sha256").update(secret).digest();
  return actual.length === expectedHash.length && crypto.timingSafeEqual(actual, expectedHash);
}

function stateFor(key) {
  const window = currentWindow();
  const current = usage.get(key.id);
  if (!current || current.window !== window) {
    const fresh = { window, count: 0, totalTokens: 0, estimatedCostUsd: 0 };
    usage.set(key.id, fresh);
    return fresh;
  }
  return current;
}

function takeQuota(key) {
  const state = stateFor(key);
  if (state.count >= key.quota) return { allowed: false, used: state.count, limit: key.quota, window: state.window };
  state.count += 1;
  return { allowed: true, used: state.count, limit: key.quota, window: state.window };
}

function numericEnv(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function pricePerMillion(provider, model) {
  const p = String(provider || "").toLowerCase();
  const m = String(model || "").toLowerCase();

  const customInput = numericEnv(`ORACLE_${p.toUpperCase()}_INPUT_USD_PER_M`);
  const customOutput = numericEnv(`ORACLE_${p.toUpperCase()}_OUTPUT_USD_PER_M`);
  if (customInput !== null && customOutput !== null) return { input: customInput, output: customOutput, source: "env" };

  if (p === "openai" && (m === "gpt-5.6" || m.includes("gpt-5.6-sol"))) return { input: 4, output: 20, source: "known-model" };
  if (p === "anthropic" && (m.includes("claude-sonnet-5") || m.includes("sonnet-5"))) return { input: 2, output: 10, source: "known-model" };
  return null;
}

function estimateCost(telemetry) {
  const pricing = pricePerMillion(telemetry?.provider, telemetry?.model);
  if (!pricing) return null;
  const inputTokens = Number(telemetry?.inputTokens || 0);
  const outputTokens = Number(telemetry?.outputTokens || 0);
  const usd = (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
  return {
    usd: Number(usd.toFixed(6)),
    inputUsdPerMillion: pricing.input,
    outputUsdPerMillion: pricing.output,
    pricingSource: pricing.source
  };
}

function meterResponse(key, body) {
  const state = stateFor(key);
  if (body?.telemetry) {
    const tokens = Number(body.telemetry.totalTokens || 0);
    state.totalTokens += tokens;
    const estimate = estimateCost(body.telemetry);
    if (estimate) {
      state.estimatedCostUsd = Number((state.estimatedCostUsd + estimate.usd).toFixed(6));
      body.telemetry.estimatedCost = estimate;
    } else {
      body.telemetry.estimatedCost = null;
    }
  }

  if (body && typeof body === "object" && !Array.isArray(body) && !body.quota) {
    body.quota = {
      window: state.window,
      limit: key.quota,
      used: state.count,
      remaining: Math.max(0, key.quota - state.count),
      currentProcessTokens: state.totalTokens,
      currentProcessEstimatedCostUsd: state.estimatedCostUsd
    };
  }
  return body;
}

export function requireApiKey(req, res, next) {
  if (!API_KEYS.length) {
    return res.status(503).json({ error: "Developer API is not configured. Set ORACLE_API_KEYS." });
  }

  const auth = String(req.get("authorization") || "");
  const headerKey = String(req.get("x-oracle-key") || "");
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const provided = bearer || headerKey;
  if (!provided) return res.status(401).json({ error: "Missing Oracle API key." });

  const match = API_KEYS.find(key => safeMatch(provided, key.secretHash));
  if (!match) return res.status(401).json({ error: "Invalid Oracle API key." });

  const meterQuota = req.method !== "GET";
  const quota = meterQuota ? takeQuota(match) : (() => { const state = stateFor(match); return { allowed: true, used: state.count, limit: match.quota, window: state.window }; })();
  res.set("X-Oracle-Quota-Limit", String(quota.limit));
  res.set("X-Oracle-Quota-Used", String(quota.used));
  res.set("X-Oracle-Quota-Remaining", String(Math.max(0, quota.limit - quota.used)));
  res.set("X-Oracle-Quota-Window", quota.window);

  if (!quota.allowed) {
    return res.status(429).json({
      error: "Oracle API quota exceeded for the current UTC month.",
      apiKeyId: match.id,
      quota: quota.limit,
      window: quota.window
    });
  }

  const originalJson = res.json.bind(res);
  res.json = body => originalJson(meterResponse(match, body));

  req.oracleApiKeyId = match.id;
  req.oracleQuota = quota;
  next();
}

export function configuredApiKeyIds() {
  return API_KEYS.map(key => key.id);
}

export function quotaSnapshot(apiKeyId) {
  const key = API_KEYS.find(item => item.id === apiKeyId);
  if (!key) return null;
  const state = stateFor(key);
  return {
    apiKeyId,
    window: state.window,
    limit: key.quota,
    used: state.count,
    remaining: Math.max(0, key.quota - state.count),
    currentProcessTokens: state.totalTokens,
    currentProcessEstimatedCostUsd: state.estimatedCostUsd
  };
}
