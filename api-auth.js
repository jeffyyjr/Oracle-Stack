import crypto from "crypto";

function parseKeys() {
  const raw = String(process.env.ORACLE_API_KEYS || "").trim();
  if (!raw) return [];
  return raw.split(",").map(entry => entry.trim()).filter(Boolean).map(entry => {
    const split = entry.indexOf(":");
    if (split <= 0) return null;
    const id = entry.slice(0, split).trim();
    const secret = entry.slice(split + 1).trim();
    if (!id || !secret) return null;
    return { id, secretHash: crypto.createHash("sha256").update(secret).digest() };
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

  req.oracleApiKeyId = match.id;
  next();
}

export function configuredApiKeyIds() {
  return API_KEYS.map(key => key.id);
}
