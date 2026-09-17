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
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1));
    throw new Error("Model returned invalid JSON.");
  }
}

async function callModel({ model, prompt, effort = "low", maxOutputTokens = 2400 }) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured.");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: prompt, reasoning: { effort }, max_output_tokens: maxOutputTokens, store: false }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `OpenAI request failed with HTTP ${response.status}`);
  const text = extractOutputText(payload);
  if (!text) throw new Error("Model returned no text.");
  return text;
}

async function routeWithOracle(request) {
  const raw = await callModel({ model: ORACLE_MODEL, maxOutputTokens: 800, prompt: `You are Oracle, the orchestration layer. Analyze the user's request so the system can quietly plan and execute it.
Allowed domains: business, research, writing, coding, career, general.
Return ONLY JSON:
{"domain":"business|research|writing|coding|career|general","task":"short description","goal":"desired result","constraints":[],"missing_information":[],"complexity":"simple|standard|advanced","depth":"light|normal|deep","notes":"brief note"}
Rules: preserve intent; never invent constraints; missing_information only for facts that truly matter; use light depth for straightforward tasks, normal for meaningful multi-step work, deep only when complexity warrants it.
USER REQUEST:\n${request}` });
  const route = parseJson(raw);
  const domain = String(route.domain || "general").toLowerCase();
  route.domain = SPECIALISTS.has(domain) ? domain : "general";
  route.constraints = Array.isArray(route.constraints) ? route.constraints : [];
  route.missing_information = Array.isArray(route.missing_information) ? route.missing_information : [];
  route.depth = ["light", "normal", "deep"].includes(route.depth) ? route.depth : "normal";
  return route;
}

function specialistProfile(domain) {
  return ({
    business: "You are a sharp business operator focused on practical execution, learning speed, measurable outcomes, and commercial usefulness.",
    research: "You are a rigorous research lead focused on evidence, uncertainty, competing explanations, and useful synthesis.",
    writing: "You are an expert writing director focused on audience, voice, structure, purpose, and polished deliverables.",
    coding: "You are a senior software architect and implementation lead focused on requirements, edge cases, security, testing, maintainability, and runnable results.",
    career: "You are a career strategy specialist focused on the target role, evidence, positioning, readability, and concrete actions.",
    general: "You are a high-level task architect who converts plain-language intent into precise execution instructions without needless ceremony."
  })[domain] || "You are a high-level task architect.";
}

async function buildStack({ request, route, repairInstructions = "" }) {
  const depthRules = route.depth === "light"
    ? "Keep this compact. Use only the minimum structure needed; often 3-6 short instructions are enough."
    : route.depth === "deep"
      ? "Use detailed structure where it materially improves execution, but still avoid filler."
      : "Use moderate structure. Include only sections that materially improve execution.";
  return callModel({ model: AGENT_MODEL, effort: route.depth === "deep" ? "medium" : "low", maxOutputTokens: route.depth === "light" ? 900 : 2200, prompt: `${specialistProfile(route.domain)}
You are the hidden planning specialist inside Oracle Stack. Create an internal execution Stack for another AI. The user will NOT normally see this Stack.
ORIGINAL REQUEST:\n${request}\n\nORACLE ROUTE:\n${JSON.stringify(route, null, 2)}
${repairInstructions ? `\nREPAIR NOTES:\n${repairInstructions}` : ""}
${depthRules}
Preserve intent and constraints. Do not invent facts, budgets, deadlines, credentials, sources, or preferences. If a missing detail is nonessential, use a labeled assumption. If it is essential, instruct the executor to ask a concise clarification rather than hallucinating. Do not make dangerous, illegal, deceptive, privacy-invasive, or manipulative requests more actionable.
Return ONLY the internal execution instructions.` });
}

async function judgeStack({ request, route, stack }) {
  const raw = await callModel({ model: JUDGE_MODEL, maxOutputTokens: 600, prompt: `You are planning QA. Compare this hidden execution Stack to the original request.
ORIGINAL:\n${request}\nROUTE:\n${JSON.stringify(route)}\nSTACK:\n${stack}
Return ONLY JSON: {"pass":true,"issues":[],"repair_instructions":""}.
Fail if intent changed, constraints were lost, facts were invented, the plan is bloated for the task, instructions conflict, or unsafe/deceptive behavior became more actionable.` });
  const r = parseJson(raw);
  return { pass: Boolean(r.pass), issues: Array.isArray(r.issues) ? r.issues : [], repair_instructions: String(r.repair_instructions || "") };
}

async function executeStack({ request, route, stack, repairInstructions = "" }) {
  return callModel({ model: AGENT_MODEL, effort: route.depth === "deep" ? "medium" : "low", maxOutputTokens: route.depth === "light" ? 1800 : 4200, prompt: `${specialistProfile(route.domain)}
You are the execution specialist inside Oracle Stack. Complete the user's task now. The planning Stack below is internal guidance, not content to show the user.
USER REQUEST:\n${request}\n\nINTERNAL STACK:\n${stack}
${repairInstructions ? `\nFINAL-ANSWER QA REPAIR NOTES:\n${repairInstructions}` : ""}
Rules:
- Produce the finished useful answer/deliverable, not a prompt explaining how to do it.
- Preserve the user's intent and requested format.
- Never claim you used tools, browsed, created files, contacted people, or performed external actions unless the request/context actually provides that capability and evidence.
- Do not fabricate missing facts. Ask a concise clarification only when execution truly cannot proceed responsibly without it; otherwise state a reasonable assumption briefly and continue.
- Match detail to the task. Simple tasks get concise answers; complex tasks can be deeper.
- Return ONLY the user-facing result.` });
}

async function judgeAnswer({ request, route, answer }) {
  const raw = await callModel({ model: JUDGE_MODEL, maxOutputTokens: 650, prompt: `You are final-answer QA. Judge the answer against the user's original request.
ORIGINAL:\n${request}\nROUTE:\n${JSON.stringify(route)}\nANSWER:\n${answer}
Return ONLY JSON: {"pass":true,"issues":[],"repair_instructions":""}.
Fail only for material problems: not answering the task, changed intent, ignored constraints, fabricated facts/actions, internal contradictions, clearly inappropriate depth, or unsafe/deceptive actionable content. Do not fail merely for stylistic preferences.` });
  const r = parseJson(raw);
  return { pass: Boolean(r.pass), issues: Array.isArray(r.issues) ? r.issues : [], repair_instructions: String(r.repair_instructions || "") };
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "oracle-stack", apiConfigured: Boolean(OPENAI_API_KEY), mode: "autonomous-execution", models: { oracle: ORACLE_MODEL, specialist: AGENT_MODEL, judge: JUDGE_MODEL } }));

app.post("/api/oracle", async (req, res) => {
  try {
    const request = String(req.body?.request || "").trim();
    if (!request) return res.status(400).json({ error: "Request is required." });
    if (request.length > 12000) return res.status(400).json({ error: "Request is too long for V1. Keep it under 12,000 characters." });

    const route = await routeWithOracle(request);
    let stack = await buildStack({ request, route });
    let planQa = await judgeStack({ request, route, stack });
    let planRepaired = false;
    if (!planQa.pass && planQa.repair_instructions) {
      stack = await buildStack({ request, route, repairInstructions: planQa.repair_instructions });
      planRepaired = true;
      planQa = await judgeStack({ request, route, stack });
    }

    let answer = await executeStack({ request, route, stack });
    let answerQa = await judgeAnswer({ request, route, answer });
    let answerRepaired = false;
    if (!answerQa.pass && answerQa.repair_instructions) {
      answer = await executeStack({ request, route, stack, repairInstructions: answerQa.repair_instructions });
      answerRepaired = true;
      answerQa = await judgeAnswer({ request, route, answer });
    }

    res.json({ original: request, answer, route, qa: { pass: planQa.pass && answerQa.pass, planPassed: planQa.pass, answerPassed: answerQa.pass, planRepaired, answerRepaired, issues: [...planQa.issues, ...answerQa.issues] } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error?.message || "Oracle Stack failed to process the request." });
  }
});

app.listen(PORT, () => console.log(`Oracle Stack listening on port ${PORT}`));
