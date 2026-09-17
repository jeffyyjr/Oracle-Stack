import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;

const SPECIALISTS = new Set(["business", "research", "writing", "coding", "career", "general"]);
const DEPTHS = new Set(["light", "normal", "deep"]);
const ROUTER_MODEL = process.env.ORACLE_MODEL || "gpt-5.6";
const JUDGE_MODEL = process.env.JUDGE_MODEL || "gpt-5.6";
const ROUTING_POLICY = process.env.ROUTING_POLICY || "balanced"; // quality | balanced | cost

const metrics = {
  requests: 0,
  successes: 0,
  failures: 0,
  repairs: 0,
  totalMs: 0,
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  byDomain: {},
  byDepth: {},
  byModel: {}
};

// V2 learning state. This is intentionally in-memory for the first rollout.
// Move this into Postgres/Redis once routing behavior is validated in production.
const modelPerformance = new Map();
const executionIndex = new Map();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function modelRegistry() {
  const models = [
    {
      id: `openai:${process.env.AGENT_MODEL || "gpt-5.6"}`,
      provider: "openai",
      model: process.env.AGENT_MODEL || "gpt-5.6",
      enabled: Boolean(process.env.OPENAI_API_KEY),
      strengths: ["general", "business", "research", "writing", "coding", "career"],
      quality: envNumber("OPENAI_QUALITY_SCORE", 0.92),
      speed: envNumber("OPENAI_SPEED_SCORE", 0.72),
      cost: envNumber("OPENAI_COST_SCORE", 0.45)
    }
  ];

  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_MODEL) {
    models.push({
      id: `anthropic:${process.env.ANTHROPIC_MODEL}`,
      provider: "anthropic",
      model: process.env.ANTHROPIC_MODEL,
      enabled: true,
      strengths: (process.env.ANTHROPIC_STRENGTHS || "writing,research,coding,general").split(",").map(v => v.trim()).filter(Boolean),
      quality: envNumber("ANTHROPIC_QUALITY_SCORE", 0.9),
      speed: envNumber("ANTHROPIC_SPEED_SCORE", 0.68),
      cost: envNumber("ANTHROPIC_COST_SCORE", 0.5)
    });
  }

  if (process.env.GEMINI_API_KEY && process.env.GEMINI_MODEL) {
    models.push({
      id: `gemini:${process.env.GEMINI_MODEL}`,
      provider: "gemini",
      model: process.env.GEMINI_MODEL,
      enabled: true,
      strengths: (process.env.GEMINI_STRENGTHS || "research,general,coding,business").split(",").map(v => v.trim()).filter(Boolean),
      quality: envNumber("GEMINI_QUALITY_SCORE", 0.87),
      speed: envNumber("GEMINI_SPEED_SCORE", 0.82),
      cost: envNumber("GEMINI_COST_SCORE", 0.7)
    });
  }

  return models.filter(m => m.enabled);
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  return (payload?.output || []).flatMap(i => i?.content || []).map(p => p?.text || p?.value || "").filter(Boolean).join("\n").trim();
}

function parseJson(text) {
  const cleaned = text.replace(/^\s*```json\s*/i, "").replace(/^\s*```\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const a = cleaned.indexOf("{");
    const b = cleaned.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(cleaned.slice(a, b + 1));
    throw new Error("Model returned invalid JSON.");
  }
}

function normalizeUsage(usage = {}) {
  return {
    input_tokens: Number(usage.input_tokens || usage.prompt_tokens || usage.inputTokens || 0),
    output_tokens: Number(usage.output_tokens || usage.completion_tokens || usage.outputTokens || 0)
  };
}

async function callOpenAI({ model, prompt, effort = "low", maxOutputTokens = 2200 }) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured.");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: prompt, reasoning: { effort }, max_output_tokens: maxOutputTokens, store: false })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `OpenAI request failed with HTTP ${response.status}`);
  const text = extractOutputText(payload);
  if (!text) throw new Error("OpenAI returned no text.");
  return { text, usage: normalizeUsage(payload?.usage) };
}

async function callAnthropic({ model, prompt, maxOutputTokens = 2200 }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured.");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({ model, max_tokens: maxOutputTokens, messages: [{ role: "user", content: prompt }] })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `Anthropic request failed with HTTP ${response.status}`);
  const text = (payload?.content || []).map(part => part?.text || "").filter(Boolean).join("\n").trim();
  if (!text) throw new Error("Anthropic returned no text.");
  return { text, usage: normalizeUsage(payload?.usage) };
}

async function callGemini({ model, prompt, maxOutputTokens = 2200 }) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured.");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens } })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `Gemini request failed with HTTP ${response.status}`);
  const text = (payload?.candidates?.[0]?.content?.parts || []).map(part => part?.text || "").filter(Boolean).join("\n").trim();
  if (!text) throw new Error("Gemini returned no text.");
  return { text, usage: normalizeUsage(payload?.usageMetadata) };
}

async function callProvider({ provider, model, prompt, effort = "low", maxOutputTokens = 2200 }) {
  const started = Date.now();
  let result;
  if (provider === "openai") result = await callOpenAI({ model, prompt, effort, maxOutputTokens });
  else if (provider === "anthropic") result = await callAnthropic({ model, prompt, maxOutputTokens });
  else if (provider === "gemini") result = await callGemini({ model, prompt, maxOutputTokens });
  else throw new Error(`Unsupported provider: ${provider}`);

  const ms = Date.now() - started;
  metrics.calls++;
  metrics.inputTokens += result.usage.input_tokens;
  metrics.outputTokens += result.usage.output_tokens;
  return { ...result, ms, provider, model };
}

function performanceKey(modelId, domain, depth) {
  return `${modelId}|${domain}|${depth}`;
}

function getPerformance(modelId, domain, depth) {
  const key = performanceKey(modelId, domain, depth);
  return modelPerformance.get(key) || { attempts: 0, successes: 0, failures: 0, repairs: 0, feedbackTotal: 0, feedbackCount: 0, avgMs: 0 };
}

function updatePerformance({ modelId, domain, depth, success, repaired, ms }) {
  const key = performanceKey(modelId, domain, depth);
  const current = getPerformance(modelId, domain, depth);
  const attempts = current.attempts + 1;
  modelPerformance.set(key, {
    ...current,
    attempts,
    successes: current.successes + (success ? 1 : 0),
    failures: current.failures + (success ? 0 : 1),
    repairs: current.repairs + (repaired ? 1 : 0),
    avgMs: Math.round(((current.avgMs * current.attempts) + Number(ms || 0)) / attempts)
  });
}

function addFeedback(modelId, domain, depth, score) {
  const key = performanceKey(modelId, domain, depth);
  const current = getPerformance(modelId, domain, depth);
  modelPerformance.set(key, {
    ...current,
    feedbackTotal: current.feedbackTotal + score,
    feedbackCount: current.feedbackCount + 1
  });
}

function learnedScore(modelId, domain, depth) {
  const p = getPerformance(modelId, domain, depth);
  if (!p.attempts && !p.feedbackCount) return 0.5;
  const successRate = p.attempts ? p.successes / p.attempts : 0.5;
  const feedback = p.feedbackCount ? p.feedbackTotal / p.feedbackCount / 5 : 0.5;
  const repairPenalty = p.attempts ? (p.repairs / p.attempts) * 0.15 : 0;
  return Math.max(0, Math.min(1, successRate * 0.6 + feedback * 0.4 - repairPenalty));
}

function selectExecutionModel(route, requestedModel = "") {
  const models = modelRegistry();
  if (!models.length) throw new Error("No execution model provider is configured.");

  if (requestedModel) {
    const forced = models.find(m => m.id === requestedModel || m.model === requestedModel);
    if (forced) return { selected: forced, reason: "explicit_model_request", candidates: [] };
  }

  const weights = ROUTING_POLICY === "quality"
    ? { quality: 0.55, speed: 0.1, cost: 0.05, learned: 0.3 }
    : ROUTING_POLICY === "cost"
      ? { quality: 0.2, speed: 0.15, cost: 0.4, learned: 0.25 }
      : { quality: 0.35, speed: 0.15, cost: 0.2, learned: 0.3 };

  const candidates = models.map(model => {
    const domainFit = model.strengths.includes(route.domain) ? 1 : 0.72;
    const learned = learnedScore(model.id, route.domain, route.depth);
    const score = domainFit * (
      model.quality * weights.quality +
      model.speed * weights.speed +
      model.cost * weights.cost +
      learned * weights.learned
    );
    return { ...model, learned, domainFit, routingScore: Number(score.toFixed(4)) };
  }).sort((a, b) => b.routingScore - a.routingScore);

  return {
    selected: candidates[0],
    reason: `adaptive_${ROUTING_POLICY}`,
    candidates: candidates.map(({ id, provider, model, learned, domainFit, routingScore }) => ({ id, provider, model, learned, domainFit, routingScore }))
  };
}

function specialistProfile(domain) {
  return ({
    business: "sharp SaaS/business operator",
    research: "rigorous research lead",
    writing: "expert writing director",
    coding: "senior software architect",
    career: "career strategy specialist",
    general: "high-level execution specialist"
  })[domain] || "high-level execution specialist";
}

async function routeWithOracle(request) {
  const result = await callProvider({
    provider: "openai",
    model: ROUTER_MODEL,
    maxOutputTokens: 450,
    prompt: `You are Oracle Router. Classify the request and choose the MINIMUM depth needed. Return ONLY JSON: {"domain":"business|research|writing|coding|career|general","task":"short task","goal":"desired result","complexity":"simple|standard|advanced","depth":"light|normal|deep"}. Light = straightforward. Normal = meaningful multi-step. Deep = genuinely difficult/high-stakes. USER REQUEST:\n${request}`
  });
  const r = parseJson(result.text);
  r.domain = SPECIALISTS.has(String(r.domain).toLowerCase()) ? String(r.domain).toLowerCase() : "general";
  r.depth = DEPTHS.has(String(r.depth).toLowerCase()) ? String(r.depth).toLowerCase() : "normal";
  return { route: r, call: result };
}

async function execute({ request, route, executionModel, repair = "" }) {
  const limits = route.depth === "light"
    ? { tokens: 1200, length: "Prefer a concise answer, usually under 500 words unless the task inherently requires more." }
    : route.depth === "deep"
      ? { tokens: 3600, length: "Use necessary depth, but aggressively remove repetition and filler." }
      : { tokens: 2400, length: "Aim for a practical answer around 700-1200 words when appropriate; use less when possible." };

  return callProvider({
    provider: executionModel.provider,
    model: executionModel.model,
    effort: route.depth === "deep" ? "medium" : "low",
    maxOutputTokens: limits.tokens,
    prompt: `You are a ${specialistProfile(route.domain)} inside Oracle Stack. Privately improve the raw request into strong execution instructions, then execute them yourself. Never expose the internal Stack. Return only the finished work.\nREQUEST:\n${request}\nROUTE:\n${JSON.stringify(route)}${repair ? `\nQA REPAIR NOTES:\n${repair}` : ""}\n${limits.length}\nPreserve intent. Do not invent facts or external actions. Make labeled assumptions for nonessential unknowns. Ask only if a truly essential detail prevents responsible execution. Prioritize concrete useful information over exhaustive text. Do not repeat the same recommendation in multiple sections.`
  });
}

async function judgeAnswer({ request, route, answer }) {
  const result = await callProvider({
    provider: "openai",
    model: JUDGE_MODEL,
    maxOutputTokens: 400,
    prompt: `You are Oracle final QA. Return ONLY JSON {"pass":true,"issues":[],"repair_instructions":""}. Fail only for MATERIAL problems: not answering the request, changed intent, ignored explicit constraints, fabricated facts/actions, contradictions, or clearly unusable verbosity. Do not fail for minor style. ORIGINAL:\n${request}\nROUTE:\n${JSON.stringify(route)}\nANSWER:\n${answer}`
  });
  const r = parseJson(result.text);
  return {
    qa: {
      pass: Boolean(r.pass),
      issues: Array.isArray(r.issues) ? r.issues : [],
      repair_instructions: String(r.repair_instructions || "")
    },
    call: result
  };
}

app.get("/api/health", (_req, res) => res.json({
  ok: true,
  service: "oracle-stack",
  mode: "adaptive-multi-model-execution",
  routingPolicy: ROUTING_POLICY,
  providers: [...new Set(modelRegistry().map(m => m.provider))],
  models: modelRegistry().map(m => ({ id: m.id, provider: m.provider, model: m.model }))
}));

app.get("/api/models", (_req, res) => {
  const models = modelRegistry().map(({ id, provider, model, strengths, quality, speed, cost }) => ({ id, provider, model, strengths, quality, speed, cost }));
  res.json({ policy: ROUTING_POLICY, models });
});

app.get("/api/metrics", (_req, res) => res.json({
  ...metrics,
  avgMs: metrics.successes ? Math.round(metrics.totalMs / metrics.successes) : 0,
  avgCalls: metrics.requests ? Number((metrics.calls / metrics.requests).toFixed(2)) : 0,
  learnedRoutes: [...modelPerformance.entries()].map(([key, value]) => ({ key, ...value }))
}));

app.post("/api/feedback", (req, res) => {
  const executionId = String(req.body?.executionId || "").trim();
  const score = Number(req.body?.score);
  if (!executionId || !executionIndex.has(executionId)) return res.status(404).json({ error: "Unknown executionId." });
  if (!Number.isFinite(score) || score < 1 || score > 5) return res.status(400).json({ error: "score must be between 1 and 5." });

  const execution = executionIndex.get(executionId);
  addFeedback(execution.modelId, execution.domain, execution.depth, score);
  res.json({ ok: true, executionId, score });
});

app.post("/api/oracle", async (req, res) => {
  const requestStarted = Date.now();
  const executionId = crypto.randomUUID();
  metrics.requests++;

  let selectedModel = null;
  let route = null;
  let repaired = false;

  try {
    const request = String(req.body?.request || "").trim();
    const requestedModel = String(req.body?.model || "").trim();
    if (!request) return res.status(400).json({ error: "Request is required." });
    if (request.length > 12000) return res.status(400).json({ error: "Request is too long for V2. Keep it under 12,000 characters." });

    const routed = await routeWithOracle(request);
    route = routed.route;
    metrics.byDomain[route.domain] = (metrics.byDomain[route.domain] || 0) + 1;
    metrics.byDepth[route.depth] = (metrics.byDepth[route.depth] || 0) + 1;

    const modelDecision = selectExecutionModel(route, requestedModel);
    selectedModel = modelDecision.selected;
    metrics.byModel[selectedModel.id] = (metrics.byModel[selectedModel.id] || 0) + 1;

    let executed = await execute({ request, route, executionModel: selectedModel });
    let judged = await judgeAnswer({ request, route, answer: executed.text });
    let answer = executed.text;
    let repairCall = null;

    if (!judged.qa.pass && judged.qa.repair_instructions) {
      repairCall = await execute({ request, route, executionModel: selectedModel, repair: judged.qa.repair_instructions });
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
    const finalPass = repaired ? true : judged.qa.pass;

    updatePerformance({
      modelId: selectedModel.id,
      domain: route.domain,
      depth: route.depth,
      success: finalPass,
      repaired,
      ms: elapsedMs
    });

    executionIndex.set(executionId, { modelId: selectedModel.id, domain: route.domain, depth: route.depth, createdAt: Date.now() });
    if (executionIndex.size > 5000) {
      const oldest = executionIndex.keys().next().value;
      executionIndex.delete(oldest);
    }

    const telemetry = {
      executionId,
      elapsedMs,
      modelCalls: calls.length,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      specialist: route.domain,
      depth: route.depth,
      repaired,
      provider: selectedModel.provider,
      model: selectedModel.model,
      modelId: selectedModel.id,
      routingPolicy: ROUTING_POLICY,
      routingReason: modelDecision.reason,
      routingScore: selectedModel.routingScore ?? null
    };

    console.log("ORACLE_METRIC", JSON.stringify(telemetry));

    res.json({
      original: request,
      answer,
      route,
      model: {
        id: selectedModel.id,
        provider: selectedModel.provider,
        name: selectedModel.model,
        reason: modelDecision.reason
      },
      qa: {
        pass: finalPass,
        answerRepaired: repaired,
        issues: repaired ? [] : judged.qa.issues
      },
      telemetry
    });
  } catch (error) {
    metrics.failures++;
    if (selectedModel && route) {
      updatePerformance({ modelId: selectedModel.id, domain: route.domain, depth: route.depth, success: false, repaired, ms: Date.now() - requestStarted });
    }
    console.error("Oracle request failed:", error);
    res.status(500).json({ executionId, error: error?.message || "Oracle Stack failed to process the request." });
  }
});

app.listen(PORT, () => console.log(`Oracle Stack listening on port ${PORT}`));
