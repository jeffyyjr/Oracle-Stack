const RESEND_API = "https://api.resend.com";

function env(name) {
  return String(process.env[name] || "").trim();
}

function validEmail(value) {
  const candidate = String(value || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : "";
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw }; }
    if (!response.ok) throw new Error(payload?.message || payload?.error?.message || `Resend returned HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export function resendOutreachConfigured() {
  return Boolean(
    env("RESEND_API_KEY") &&
    validEmail(env("RESEND_FROM").match(/<([^>]+)>/)?.[1] || env("RESEND_FROM")) &&
    validEmail(env("RESEND_REPLY_TO")) &&
    env("SALES_SENDER_BUSINESS_NAME") &&
    env("SALES_SENDER_POSTAL_ADDRESS")
  );
}

export function resendConfigurationStatus() {
  return {
    apiKey: Boolean(env("RESEND_API_KEY")),
    from: Boolean(env("RESEND_FROM")),
    replyTo: Boolean(env("RESEND_REPLY_TO")),
    businessIdentity: Boolean(env("SALES_SENDER_BUSINESS_NAME")),
    postalAddress: Boolean(env("SALES_SENDER_POSTAL_ADDRESS")),
    webhookSecret: Boolean(env("RESEND_WEBHOOK_SECRET")),
    configured: resendOutreachConfigured()
  };
}

export async function sendResendOutreach({ lead, message }) {
  if (!resendOutreachConfigured()) throw new Error("Resend outreach is not fully configured.");
  const channel = String(lead?.evidence?.channel || "").trim().toLowerCase();
  if (!["public_rfp", "direct_email"].includes(channel)) {
    return { accepted: false, status: "held", reason: "channel_requires_platform_native_outreach" };
  }
  const to = validEmail(lead?.buyer_email || lead?.buyerEmail);
  if (!to) return { accepted: false, status: "held", reason: "verified_buyer_email_required" };

  const business = env("SALES_SENDER_BUSINESS_NAME");
  const address = env("SALES_SENDER_POSTAL_ADDRESS");
  const replyTo = env("RESEND_REPLY_TO");
  const subject = String(lead?.name || "Following up on your request").replace(/[\r\n]+/g, " ").slice(0, 160);
  const text = `${String(message || "").trim()}\n\n— ${business}\n${address}\nIf you do not want further messages, reply "unsubscribe".`;

  const sent = await fetchJson(`${RESEND_API}/emails`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env("RESEND_API_KEY")}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `oracle-sales-${lead.id}`
    },
    body: JSON.stringify({
      from: env("RESEND_FROM"),
      to: [to],
      reply_to: replyTo,
      subject,
      text
    })
  });
  if (!sent?.id) throw new Error("Resend accepted the request without returning an email id.");

  let messageId = "";
  for (let attempt = 0; attempt < 4 && !messageId; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    try {
      const retrieved = await fetchJson(`${RESEND_API}/emails/${encodeURIComponent(sent.id)}`, {
        headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}` }
      });
      messageId = String(retrieved?.message_id || "").trim();
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
  if (!messageId) throw new Error("Resend sent the email but its RFC Message-ID is not available yet.");

  return { accepted: true, sent: true, status: "sent", messageId, providerId: sent.id, to };
}
