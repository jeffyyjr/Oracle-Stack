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

function takeQuota(key) {
  const window = currentWindow();
  const current = usage.get(key.id);
  const state = !current || current.window !== window ? { window, count: 0 } : current;
  if (state.count >= key.quota) return { allowed: false, used: state.count, limit: key.quota, window };
  state.count += 1;
  usage.set(key.id, state);
  return { allowed: true, used: state.count, limit: key.quota, window };
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

  const quota = takeQuota(match);
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
  const window = currentWindow();
  const state = usage.get(apiKeyId);
  const used = state?.window === window ? state.count : 0;
  return { apiKeyId, window, limit: key.quota, used, remaining: Math.max(0, key.quota - used) };
}
