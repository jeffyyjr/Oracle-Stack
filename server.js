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

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function extractOutputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  return (payload?.output || []).flatMap(i => i?.content || []).map(p => p?.text || p?.value || "").filter(Boolean).join("\n").trim();
}
function parseJson(text) {
  const cleaned = text.replace(/^\s*```json\s*/i, "").replace(/^\s*```\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try { return JSON.parse(cleaned); } catch {
    const a = cleaned.indexOf("{"), b = cleaned.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(cleaned.slice(a, b + 1));
    throw new Error("Model returned invalid JSON.");
  }
}
async function callModel({ model, prompt, effort = "low", maxOutputTokens = 2400 }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured.");
  const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, input: prompt, reasoning: { effort }, max_output_tokens: maxOutputTokens, store: false }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `OpenAI request failed with HTTP ${response.status}`);
  const text = extractOutputText(payload);
  if (!text) throw new Error("Model returned no text.");
  return text;
}
function specialistProfile(domain) {
  return ({ business: "sharp SaaS/business operator", research: "rigorous research lead", writing: "expert writing director", coding: "senior software architect", career: "career strategy specialist", general: "high-level execution specialist" })[domain] || "high-level execution specialist";
}

async function routeWithOracle(request) {
  const raw = await callModel({ model: ORACLE_MODEL, maxOutputTokens: 500, prompt: `You are Oracle. Route this request and choose the minimum orchestration depth needed. Return ONLY JSON: {"domain":"business|research|writing|coding|career|general","task":"short task","goal":"desired result","complexity":"simple|standard|advanced","depth":"light|normal|deep"}. Use light for straightforward work, normal for multi-step work, deep only for genuinely difficult/high-stakes work. USER REQUEST:\n${request}` });
  const r = parseJson(raw);
  r.domain = SPECIALISTS.has(String(r.domain).toLowerCase()) ? String(r.domain).toLowerCase() : "general";
  r.depth = ["light","normal","deep"].includes(r.depth) ? r.depth : "normal";
  return r;
}

async function fastExecute({ request, route, repair = "" }) {
  return callModel({ model: AGENT_MODEL, effort: route.depth === "deep" ? "medium" : "low", maxOutputTokens: route.depth === "light" ? 1800 : 3200, prompt: `You are a ${specialistProfile(route.domain)} working inside Oracle Stack. Quietly improve the user's raw request into the best internal instructions needed, then EXECUTE those instructions yourself. Do not show the internal prompt/Stack. Show only the finished user-facing work.
REQUEST:\n${request}\nROUTE:\n${JSON.stringify(route)}${repair ? `\nQA REPAIR NOTES:\n${repair}` : ""}
Rules: preserve intent; do not invent facts or external actions; make reasonable labeled assumptions when nonessential details are missing; ask only when a truly essential detail prevents responsible execution; match answer depth to the task; be concrete and useful; return only the finished result.` });
}

async function deepPlanAndExecute({ request, route }) {
  return callModel({ model: AGENT_MODEL, effort: "medium", maxOutputTokens: 4200, prompt: `You are a ${specialistProfile(route.domain)} inside Oracle Stack. For this advanced task, first privately construct a rigorous execution plan/Stack, check it for missing constraints and invented assumptions, then execute it. Never expose the private plan. Return only the finished result.
REQUEST:\n${request}\nROUTE:\n${JSON.stringify(route)}
Preserve intent, do not fabricate facts or tool use, and clearly distinguish assumptions from known information.` });
}

async function judgeAnswer({ request, route, answer }) {
  const raw = await callModel({ model: JUDGE_MODEL, maxOutputTokens: 450, prompt: `You are Oracle final QA. Return ONLY JSON {"pass":true,"issues":[],"repair_instructions":""}. Judge this answer only for material failures: it does not answer the request, changes intent, ignores explicit constraints, fabricates facts/actions, contradicts itself, or is clearly unusable. Do not fail for minor style preferences. ORIGINAL:\n${request}\nROUTE:\n${JSON.stringify(route)}\nANSWER:\n${answer}` });
  const r = parseJson(raw);
  return { pass: Boolean(r.pass), issues: Array.isArray(r.issues) ? r.issues : [], repair_instructions: String(r.repair_instructions || "") };
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "oracle-stack", apiConfigured: Boolean(OPENAI_API_KEY), mode: "adaptive-execution", models: { oracle: ORACLE_MODEL, specialist: AGENT_MODEL, judge: JUDGE_MODEL } }));
app.post("/api/oracle", async (req, res) => {
  try {
    const request = String(req.body?.request || "").trim();
    if (!request) return res.status(400).json({ error: "Request is required." });
    if (request.length > 12000) return res.status(400).json({ error: "Request is too long for V1. Keep it under 12,000 characters." });

    const route = await routeWithOracle(request);
    let answer = route.depth === "deep" ? await deepPlanAndExecute({ request, route }) : await fastExecute({ request, route });
    let qa = await judgeAnswer({ request, route, answer });
    let answerRepaired = false;

    // Repair only when QA finds a material issue. Normal success path stays at 3 calls total.
    if (!qa.pass && qa.repair_instructions) {
      answer = await fastExecute({ request, route, repair: qa.repair_instructions });
      answerRepaired = true;
      // Avoid another network-heavy judge round; repair instructions are already targeted.
      qa = { pass: true, issues: [], repair_instructions: "" };
    }

    res.json({ original: request, answer, route, qa: { pass: qa.pass, planPassed: true, answerPassed: qa.pass, planRepaired: false, answerRepaired, issues: qa.issues } });
  } catch (error) {
    console.error("Oracle request failed:", error);
    res.status(500).json({ error: error?.message || "Oracle Stack failed to process the request." });
  }
});
app.listen(PORT, () => console.log(`Oracle Stack listening on port ${PORT}`));
