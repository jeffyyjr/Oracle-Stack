import crypto from "crypto";
import express from "express";
import { classifyInboundReply } from "./sales-force.js";
import { ingestSalesReply } from "./storage.js";

const nativeFetch = globalThis.fetch.bind(globalThis);
const nativeJson = express.json.bind(express);

function text(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

function webhookHeader(headers, name) {
  const target = String(name || "").toLowerCase();
  if (Array.isArray(headers)) {
    const found = headers.find(item => String(item?.name || item?.key || "").toLowerCase() === target);
    return text(found?.value, 4000);
  }
  if (headers && typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) if (String(key).toLowerCase() === target) return text(value, 4000);
  }
  return "";
}

export function validResendWebhookSignature(rawBody, headers = {}, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const id = text(headers["svix-id"] || headers["Svix-Id"], 512);
  const timestamp = Number(headers["svix-timestamp"] || headers["Svix-Timestamp"]);
  const signature = text(headers["svix-signature"] || headers["Svix-Signature"], 4000);
  const configured = String(secret || "").trim();
  if (!id || !Number.isFinite(timestamp) || !signature || !configured) return false;
  if (Math.abs(nowSeconds - timestamp) > 300) return false;
  const encodedKey = configured.replace(/^whsec_/, "");
  let key;
  try { key = Buffer.from(encodedKey, "base64"); } catch { return false; }
  if (!key.length) return false;
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
  const expected = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${payload}`).digest("base64");
  return signature.split(/\s+/).some(part => {
    const [version, supplied] = part.split(",", 2);
    if (version !== "v1" || !supplied) return false;
    const a = Buffer.from(supplied), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

function referencesFallback(value) {
  const matches = String(value || "").match(/<[^>]+>/g);
  return matches?.length ? matches[matches.length - 1] : "";
}

async function getResendReceivedEmail(emailId) {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured.");
  const response = await nativeFetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
  });
  const raw = await response.text();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }
  if (!response.ok) throw new Error(payload?.message || `Resend receiving API returned HTTP ${response.status}`);
  return payload;
}

async function ingestResendReply(req, res) {
  const secret = String(process.env.RESEND_WEBHOOK_SECRET || "").trim();
  if (!secret) return res.status(503).json({ error: "Resend webhook is not configured." });
  const headers = {
    "svix-id": req.get("svix-id"),
    "svix-timestamp": req.get("svix-timestamp"),
    "svix-signature": req.get("svix-signature")
  };
  if (!validResendWebhookSignature(req.rawBody, headers, secret)) return res.status(401).json({ error: "Invalid Resend webhook signature." });
  const event = req.body || {};
  if (event.type !== "email.received") return res.status(200).json({ accepted: true, ignored: true });
  const emailId = text(event.data?.email_id, 240);
  if (!emailId) return res.status(202).json({ accepted: false, action: "hold", reason: "missing_resend_email_id" });

  const email = await getResendReceivedEmail(emailId);
  const inReplyTo = webhookHeader(email.headers, "in-reply-to")
    || text(email.in_reply_to, 512)
    || referencesFallback(webhookHeader(email.headers, "references"));
  const htmlFallback = String(email.html || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const bodyText = text(email.text || email.body || htmlFallback, 8000);
  const reply = {
    text: bodyText,
    messageId: text(email.message_id || event.data?.message_id || emailId, 240),
    inReplyTo,
    from: text(email.from || event.data?.from, 500),
    subject: text(email.subject || event.data?.subject, 500),
    resendEmailId: emailId
  };
  const classification = classifyInboundReply(reply);
  if (!classification.accepted) return res.status(202).json({ accepted: false, action: "hold", reason: classification.reason });
  const result = await ingestSalesReply({ classification, reply });
  return res.status(result.accepted ? 200 : 202).json(result);
}

export function validOutreachReceipt(payload = {}) {
  const status = text(payload.status || payload.deliveryStatus, 40).toLowerCase();
  const messageId = text(payload.messageId || payload.id, 240);
  const accepted = payload.accepted === true || payload.sent === true || ["accepted", "sent", "delivered"].includes(status);
  return Boolean(accepted && messageId);
}

export function validInboundSignature(rawBody, signature, secret) {
  const key = String(secret || "");
  const supplied = text(signature, 512).replace(/^sha256=/i, "");
  if (!key || !/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = crypto.createHmac("sha256", key).update(rawBody || Buffer.alloc(0)).digest("hex");
  const a = Buffer.from(supplied.toLowerCase(), "hex"), b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function correlateInboundReply(leads = [], inReplyTo = "") {
  const matches = leads.filter(lead => String(lead.external_message_id || "") === String(inReplyTo || ""));
  if (matches.length !== 1) return { matched: false, reason: matches.length ? "ambiguous_outbound_message" : "unknown_outbound_message" };
  if (!["contacted", "replied"].includes(matches[0].stage)) return { matched: false, reason: "lead_not_awaiting_reply" };
  return { matched: true, lead: matches[0] };
}

async function ingestInboundReply(req, res) {
  const secret = String(process.env.SALES_INBOUND_WEBHOOK_SECRET || "");
  if (!secret) return res.status(503).json({ error: "Inbound reply webhook is not configured." });
  if (!validInboundSignature(req.rawBody, req.get("x-oracle-signature"), secret)) return res.status(401).json({ error: "Invalid inbound webhook signature." });

  const body = req.body?.data && typeof req.body.data === "object" ? req.body.data : (req.body || {});
  const classification = classifyInboundReply(body);
  if (!classification.accepted) return res.status(202).json({ accepted: false, action: "hold", reason: classification.reason });
  const result=await ingestSalesReply({classification,reply:body});
  return res.status(result.accepted?200:202).json(result);
}

export function installInboundReplyGate() {
  if (globalThis.__oracleInboundReplyGateInstalled) return;
  globalThis.__oracleInboundReplyGateInstalled = true;
  express.json = function oracleJson(options = {}) {
    const callerVerify = options.verify;
    const parser = nativeJson({ ...options, verify(req, res, buf, encoding) { req.rawBody = Buffer.from(buf); if (callerVerify) callerVerify(req, res, buf, encoding); } });
    return async function oracleJsonWithInbound(req, res, next) {
      parser(req, res, async error => {
        if (error) return next(error);
        if (req.method === "POST" && req.path === "/api/sales/inbound") {
          try { return await ingestInboundReply(req, res); }
          catch (ingestError) { console.error("Inbound reply ingestion failed:", ingestError.message); return res.status(500).json({ error: "Inbound reply ingestion failed." }); }
        }
        if (req.method === "POST" && req.path === "/api/sales/resend/inbound") {
          try { return await ingestResendReply(req, res); }
          catch (ingestError) { console.error("Resend inbound ingestion failed:", ingestError.message); return res.status(500).json({ error: "Resend inbound ingestion failed." }); }
        }
        next();
      });
    };
  };
}

export function installOutreachFetchGuard() {
  if (globalThis.__oracleOutreachFetchGuardInstalled) return;
  globalThis.__oracleOutreachFetchGuardInstalled = true;
  globalThis.fetch = async function oracleGuardedFetch(input, init) {
    const response = await nativeFetch(input, init);
    const configured = String(process.env.SALES_OUTREACH_WEBHOOK_URL || "").trim();
    const target = typeof input === "string" ? input : input?.url;
    if (!configured || target !== configured || String(init?.method || "GET").toUpperCase() !== "POST" || !response.ok) return response;
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }
    if (!validOutreachReceipt(payload)) return new Response(JSON.stringify({ error: "Outreach connector did not provide a confirmed delivery receipt." }), { status: 502, headers: { "content-type": "application/json", "x-oracle-outreach-gate": "rejected" } });
    return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

installInboundReplyGate();
installOutreachFetchGuard();
