import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { classifyInboundReply } from "./sales-force.js";
import { ingestSalesReply, listSalesLeads } from "./storage.js";

let lastUid = null;
let polling = false;

function env(name) {
  return String(process.env[name] || "").trim();
}

function validEmail(value) {
  const candidate = String(value || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : "";
}

export function gmailOutreachEligible(lead = {}) {
  const channel = String(lead?.evidence?.channel || "").trim().toLowerCase();
  return ["public_rfp", "direct_email"].includes(channel) && Boolean(validEmail(lead?.buyer_email || lead?.buyerEmail));
}

export function gmailOutreachConfigured() {
  return Boolean(
    validEmail(env("GMAIL_USER")) &&
    env("GMAIL_APP_PASSWORD") &&
    env("SALES_SENDER_BUSINESS_NAME") &&
    env("SALES_SENDER_POSTAL_ADDRESS")
  );
}

export function gmailConfigurationStatus() {
  return {
    user: Boolean(validEmail(env("GMAIL_USER"))),
    appPassword: Boolean(env("GMAIL_APP_PASSWORD")),
    businessIdentity: Boolean(env("SALES_SENDER_BUSINESS_NAME")),
    postalAddress: Boolean(env("SALES_SENDER_POSTAL_ADDRESS")),
    configured: gmailOutreachConfigured()
  };
}

function transporter() {
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    requireTLS: true,
    family: 4,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: { user: env("GMAIL_USER"), pass: env("GMAIL_APP_PASSWORD") }
  });
}

export async function verifyGmailConnection() {
  if (!gmailOutreachConfigured()) return { ok: false, reason: "gmail_not_fully_configured" };
  await transporter().verify();
  return { ok: true };
}

export async function sendGmailOutreach({ lead, message }) {
  if (!gmailOutreachConfigured()) throw new Error("Gmail outreach is not fully configured.");
  if (!gmailOutreachEligible(lead)) {
    const channel = String(lead?.evidence?.channel || "").trim().toLowerCase();
    return {
      accepted: false,
      status: "held",
      reason: validEmail(lead?.buyer_email || lead?.buyerEmail)
        ? "channel_requires_platform_native_outreach"
        : "verified_buyer_email_required",
      channel
    };
  }

  const to = validEmail(lead?.buyer_email || lead?.buyerEmail);
  const user = validEmail(env("GMAIL_USER"));
  const business = env("SALES_SENDER_BUSINESS_NAME");
  const address = env("SALES_SENDER_POSTAL_ADDRESS");
  const fromName = env("GMAIL_FROM_NAME") || business;
  const subject = String(lead?.name || "Following up on your request").replace(/[\r\n]+/g, " ").slice(0, 160);
  const body = `${String(message || "").trim()}\n\n— ${business}\n${address}\nIf you do not want further messages, reply "unsubscribe".`;

  const sent = await transporter().sendMail({
    from: { name: fromName, address: user },
    to,
    replyTo: user,
    subject,
    text: body
  });
  const messageId = String(sent?.messageId || "").trim();
  if (!messageId) throw new Error("Gmail sent the email without returning a Message-ID.");

  return { accepted: true, sent: true, status: "sent", messageId, to };
}

function normalizeMessageId(value) {
  return String(value || "").trim();
}

export async function pollGmailReplies() {
  if (polling || !gmailOutreachConfigured()) return { ok: false, skipped: true };
  polling = true;
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: env("GMAIL_USER"), pass: env("GMAIL_APP_PASSWORD") },
    logger: false
  });

  let processed = 0;
  try {
    const active = (await listSalesLeads({ limit: 500 }))
      .filter(lead => ["contacted", "replied"].includes(lead.stage) && lead.external_message_id);
    const messageIds = new Set(active.map(lead => normalizeMessageId(lead.external_message_id)));
    if (!messageIds.size) return { ok: true, processed: 0 };

    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uidNext = Number(client.mailbox?.uidNext || 1);
      if (lastUid === null) lastUid = Math.max(1, uidNext - 100);
      const start = Math.max(1, lastUid + 1);
      if (start >= uidNext) return { ok: true, processed: 0 };

      for await (const msg of client.fetch(`${start}:*`, { uid: true, source: true })) {
        lastUid = Math.max(lastUid || 0, Number(msg.uid || 0));
        if (!msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const inReplyTo = normalizeMessageId(parsed.inReplyTo);
        if (!inReplyTo || !messageIds.has(inReplyTo)) continue;

        const reply = {
          text: String(parsed.text || "").trim().slice(0, 8000),
          messageId: normalizeMessageId(parsed.messageId) || `gmail-uid-${msg.uid}`,
          inReplyTo,
          from: String(parsed.from?.text || "").slice(0, 500),
          subject: String(parsed.subject || "").slice(0, 500),
          gmailUid: Number(msg.uid || 0)
        };
        const classification = classifyInboundReply(reply);
        if (!classification.accepted) continue;
        await ingestSalesReply({ classification, reply });
        processed++;
      }
    } finally {
      lock.release();
    }
    return { ok: true, processed };
  } finally {
    try { await client.logout(); } catch {}
    polling = false;
  }
}
