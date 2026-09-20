import crypto from "crypto";
import express from "express";
import { classifyInboundReply } from "./sales-force.js";
import { listSalesLeads, listSalesEvents, updateSalesLead, recordSalesEvent } from "./storage.js";

const nativeFetch = globalThis.fetch.bind(globalThis);
const nativeJson = express.json.bind(express);

function text(value, max = 240) {
  return String(value || "").trim().slice(0, max);
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

  const events = await listSalesEvents(null, 500);
  if (events.some(event => String(event.detail?.providerMessageId || "") === classification.providerMessageId)) {
    return res.status(200).json({ accepted: true, duplicate: true, action: "ignore" });
  }

  const leads = await listSalesLeads({ limit: 500 });
  const correlation = correlateInboundReply(leads, classification.inReplyTo);
  if (!correlation.matched) {
    await recordSalesEvent({ eventType: "reply_unmatched", detail: { providerMessageId: classification.providerMessageId, inReplyTo: classification.inReplyTo, reason: correlation.reason } });
    return res.status(202).json({ accepted: false, action: "hold", reason: correlation.reason });
  }

  const lead = correlation.lead;
  let stage = lead.stage;
  if (classification.action === "advance") stage = "replied";
  if (["close", "suppress"].includes(classification.action)) stage = "lost";
  const notes = classification.action === "suppress" ? `${lead.notes || ""}\nInbound opt-out received; suppress future outreach.`.trim().slice(0, 4000) : undefined;
  const updated = await updateSalesLead(lead.id, { stage, notes });
  await recordSalesEvent({ campaignId: lead.campaign_id, leadId: lead.id, eventType: `reply_${classification.classification}`, detail: { providerMessageId: classification.providerMessageId, inReplyTo: classification.inReplyTo, action: classification.action } });
  return res.status(200).json({ accepted: true, classification: classification.classification, action: classification.action, leadId: lead.id, stage: updated.stage });
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
