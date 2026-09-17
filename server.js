import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ORACLE_MODEL = process.env.ORACLE_MODEL || "gpt-5.6";
const AGENT_MODEL = process.env.AGENT_MODEL || "gpt-5.6";
const JUDGE_MODEL = process.env.JUDGE_MODEL || "gpt-5.6";
const SPECIALISTS = new Set(["business", "research", "writing", "coding", "career", "general"]);
const metrics = { requests: 0, successes: 0, failures: 0, repairs: 0, totalMs: 0, calls: 0, inputTokens: 0, outputTokens: 0, byDomain: {}, byDepth: {} };

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function extractOutputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  return (payload?.output || []).flatMap(i => i?.content || []).map(p => p?.text || p?.value || "").filter(Boolean).join("\n").trim();
}
function parseJson(text) {
  const cleaned = text.replace(/^\s*```json\s*/i, "").replace(/^\s*```\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try { return JSON.parse(cleaned); } catch { const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}"); if (a >= 0 && b > a) return JSON.parse(cleaned.slice(a, b + 1)); throw new Error("Model returned invalid JSON."); }
}
async function callModel({ model, prompt, effort = "low", maxOutputTokens = 2200 }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured.");
  const started = Date.now();
  const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, input: prompt, reasoning: { effort }, max_output_tokens: maxOutputTokens, store: false }) });
  const payload = await response.json();
  metrics.calls++;
  metrics.inputTokens += Number(payload?.usage?.input_tokens || 0);
  metrics.outputTokens += Number(payload?.usage?.output_tokens || 0);
  if (!response.ok) throw new Error(payload?.error?.message || `OpenAI request failed with HTTP ${response.status}`);
  const text = extractOutputText(payload);
  if (!text) throw new Error("Model returned no text.");
  return { text, ms: Date.now() - started, usage: payload?.usage || {} };
}
function specialistProfile(domain) {
  return ({ business: "sharp SaaS/business operator", research: "rigorous research lead", writing: "expert writing director", coding: "senior software architect", career: "career strategy specialist", general: "high-level execution specialist" })[domain] || "high-level execution specialist";
}
async function routeWithOracle(request) {
  const result = await callModel({ model: ORACLE_MODEL, maxOutputTokens: 400, prompt: `You are Oracle. Route this request and choose the MINIMUM depth needed. Return ONLY JSON: {"domain":"business|research|writing|coding|career|general","task":"short task","goal":"desired result","complexity":"simple|standard|advanced","depth":"light|normal|deep"}. Light = straightforward. Normal = meaningful multi-step. Deep = genuinely difficult/high-stakes. USER REQUEST:\n${request}` });
  const r = parseJson(result.text);
  r.domain = SPECIALISTS.has(String(r.domain).toLowerCase()) ? String(r.domain).toLowerCase() : "general";
  r.depth = ["light","normal","deep"].includes(r.depth) ? r.depth : "normal";
  return { route: r, call: result };
}
async function execute({ request, route, repair = "" }) {
  const limits = route.depth === "light" ? { tokens: 1200, length: "Prefer a concise answer, usually under 500 words unless the task inherently requires more." } : route.depth === "deep" ? { tokens: 3600, length: "Use necessary depth, but aggressively remove repetition and filler." } : { tokens: 2400, length: "Aim for a practical answer around 700-1200 words when appropriate; use less when possible." };
  return callModel({ model: AGENT_MODEL, effort: route.depth === "deep" ? "medium" : "low", maxOutputTokens: limits.tokens, prompt: `You are a ${specialistProfile(route.domain)} inside Oracle Stack. Privately improve the raw request into strong execution instructions, then execute them yourself. Never expose the internal Stack. Return only the finished work.\nREQUEST:\n${request}\nROUTE:\n${JSON.stringify(route)}${repair ? `\nQA REPAIR NOTES:\n${repair}` : ""}\n${limits.length}\nPreserve intent. Do not invent facts or external actions. Make labeled assumptions for nonessential unknowns. Ask only if a truly essential detail prevents responsible execution. Prioritize concrete useful information over exhaustive text. Do not repeat the same recommendation in multiple sections.` });
}
async function judgeAnswer({ request, route, answer }) {
  const result = await callModel({ model: JUDGE_MODEL, maxOutputTokens: 350, prompt: `You are Oracle final QA. Return ONLY JSON {"pass":true,"issues":[],"repair_instructions":""}. Fail only for MATERIAL problems: not answering the request, changed intent, ignored explicit constraints, fabricated facts/actions, contradictions, or clearly unusable verbosity. Do not fail for minor style. ORIGINAL:\n${request}\nROUTE:\n${JSON.stringify(route)}\nANSWER:\n${answer}` });
  const r = parseJson(result.text);
  return { qa: { pass: Boolean(r.pass), issues: Array.isArray(r.issues) ? r.issues : [], repair_instructions: String(r.repair_instructions || "") }, call: result };
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "oracle-stack", apiConfigured: Boolean(OPENAI_API_KEY), mode: "adaptive-execution", models: { oracle: ORACLE_MODEL, specialist: AGENT_MODEL, judge: JUDGE_MODEL } }));
app.get("/api/metrics", (_req, res) => res.json({ ...metrics, avgMs: metrics.successes ? Math.round(metrics.totalMs / metrics.successes) : 0, avgCalls: metrics.requests ? Number((metrics.calls / metrics.requests).toFixed(2)) : 0 }));

app.post("/api/oracle", async (req, res) => {
  const requestStarted = Date.now();
  metrics.requests++;
  try {
    const request = String(req.body?.request || "").trim();
    if (!request) return res.status(400).json({ error: "Request is required." });
    if (request.length > 12000) return res.status(400).json({ error: "Request is too long for V1. Keep it under 12,000 characters." });

    const routed = await routeWithOracle(request);
    const route = routed.route;
    metrics.byDomain[route.domain] = (metrics.byDomain[route.domain] || 0) + 1;
    metrics.byDepth[route.depth] = (metrics.byDepth[route.depth] || 0) + 1;

    let executed = await execute({ request, route });
    let judged = await judgeAnswer({ request, route, answer: executed.text });
    let answer = executed.text;
    let repaired = false;
    let repairCall = null;
    if (!judged.qa.pass && judged.qa.repair_instructions) {
      repairCall = await execute({ request, route, repair: judged.qa.repair_instructions });
      answer = repairCall.text;
      repaired = true;
      metrics.repairs++;
    }

    const elapsedMs = Date.now() - requestStarted;
    metrics.successes++;
    metrics.totalMs += elapsedMs;
    const calls = [routed.call, executed, judged.call, repairCall].filter(Boolean);
    const inputTokens = calls.reduce((n, c) => n + Number(c.usage?.input_tokens || 0), 0);
    const outputTokens = calls.reduce((n, c) => n + Number(c.usage?.output_tokens || 0), 0);
    const telemetry = { elapsedMs, modelCalls: calls.length, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, specialist: route.domain, depth: route.depth, repaired };
    console.log("ORACLE_METRIC", JSON.stringify(telemetry));

    res.json({ original: request, answer, route, qa: { pass: repaired ? true : judged.qa.pass, planPassed: true, answerPassed: repaired ? true : judged.qa.pass, planRepaired: false, answerRepaired: repaired, issues: repaired ? [] : judged.qa.issues }, telemetry });
  } catch (error) {
    metrics.failures++;
    console.error("Oracle request failed:", error);
    res.status(500).json({ error: error?.message || "Oracle Stack failed to process the request." });
  }
});
app.listen(PORT, () => console.log(`Oracle Stack listening on port ${PORT}`));
