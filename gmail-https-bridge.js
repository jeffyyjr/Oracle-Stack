import crypto from "crypto";

function env(name) {
  return String(process.env[name] || "").trim();
}

function validEmail(value) {
  const candidate = String(value || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : "";
}

function eligibleChannel(lead = {}) {
  const channel = String(lead?.evidence?.channel || "").trim().toLowerCase();
  return ["public_rfp", "direct_email"].includes(channel);
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw }; }
    if (!response.ok) throw new Error(payload?.error || payload?.message || `Gmail bridge returned HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export function gmailBridgeConfigured() {
  return Boolean(
    env("GMAIL_BRIDGE_URL") &&
    env("GMAIL_BRIDGE_SECRET") &&
    env("SALES_SENDER_BUSINESS_NAME") &&
    env("SALES_SENDER_POSTAL_ADDRESS")
  );
}

export function gmailBridgeStatus() {
  return {
    url: Boolean(env("GMAIL_BRIDGE_URL")),
    secret: Boolean(env("GMAIL_BRIDGE_SECRET")),
    businessIdentity: Boolean(env("SALES_SENDER_BUSINESS_NAME")),
    postalAddress: Boolean(env("SALES_SENDER_POSTAL_ADDRESS")),
    configured: gmailBridgeConfigured()
  };
}

export async function sendGmailBridgeOutreach({ lead, message }) {
  if (!gmailBridgeConfigured()) throw new Error("Gmail HTTPS bridge is not fully configured.");
  if (!eligibleChannel(lead)) return { accepted:false, status:"held", reason:"channel_requires_platform_native_outreach" };
  const to = validEmail(lead?.buyer_email || lead?.buyerEmail);
  if (!to) return { accepted:false, status:"held", reason:"verified_buyer_email_required" };

  const payload = {
    action: "send",
    secret: env("GMAIL_BRIDGE_SECRET"),
    oracleLeadId: lead.id,
    to,
    subject: String(lead?.name || "Following up on your request").replace(/[\r\n]+/g, " ").slice(0,160),
    text: `${String(message || "").trim()}\n\n— ${env("SALES_SENDER_BUSINESS_NAME")}\n${env("SALES_SENDER_POSTAL_ADDRESS")}\nIf you do not want further messages, reply "unsubscribe".`
  };
  const result = await fetchJson(env("GMAIL_BRIDGE_URL"), {
    method:"POST",
    headers:{ "Content-Type":"application/json", "User-Agent":"Oracle-Stack-Gmail-Bridge/1.0" },
    body:JSON.stringify(payload)
  });
  const messageId = String(result.threadId || result.messageId || "").trim();
  if (!result?.ok || !messageId) throw new Error("Gmail bridge did not return a tracked thread id.");
  return { accepted:true, sent:true, status:"sent", messageId, to, bridge:true };
}

export function bridgeInboundSignature(body, secret) {
  return crypto.createHmac("sha256", String(secret || "")).update(body).digest("hex");
}
