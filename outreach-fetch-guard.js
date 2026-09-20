const nativeFetch = globalThis.fetch.bind(globalThis);

function text(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

export function validOutreachReceipt(payload = {}) {
  const status = text(payload.status || payload.deliveryStatus, 40).toLowerCase();
  const messageId = text(payload.messageId || payload.id, 240);
  const accepted = payload.accepted === true || payload.sent === true || ["accepted", "sent", "delivered"].includes(status);
  return Boolean(accepted && messageId);
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
    if (!validOutreachReceipt(payload)) {
      return new Response(JSON.stringify({ error: "Outreach connector did not provide a confirmed delivery receipt." }), {
        status: 502,
        headers: { "content-type": "application/json", "x-oracle-outreach-gate": "rejected" }
      });
    }
    return new Response(raw, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

installOutreachFetchGuard();
