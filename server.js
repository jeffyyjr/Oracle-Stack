import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { requireApiKey, apiAuthEnabled, quotaSnapshot } from "./api-auth.js";
import { opportunityFinder } from "./agents/opportunity-finder.js";
import { buyerMatcher } from "./agents/buyer-matcher.js";
import { dealOrchestrator } from "./agents/deal-orchestrator.js";
import { discoverMarketEvidence, evidencePromptBlock, discoveryEnabled } from "./market-discovery.js";
import { techHunterInstructions } from "./agents/tech-problem-hunter.js";
import { techFixerInstructions } from "./agents/tech-fixer.js";
import { dealQualifierInstructions } from "./agents/deal-qualifier.js";
import { executionAgentInstructions } from "./agents/execution-agent.js";
import { materializeExecutionArtifacts } from "./artifact-workspace.js";
import {
  initStorage, storageEnabled, loadRoutePerformance, saveRoutePerformance,
  saveExecution, findExecution, saveFeedback, getUsageSummary
} from "./storage.js";

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const SPECIALISTS = new Set(["business", "research", "writing", "coding", "career", "revenue", "general"]);
const DEPTHS = new Set(["light", "normal", "deep"]);
const ROUTER_MODEL = process.env.ORACLE_MODEL || "gpt-5.6-sol";
const JUDGE_MODEL = process.env.JUDGE_MODEL || "gpt-5.6-sol";
const ROUTING_POLICY = process.env.ROUTING_POLICY || "balanced";
const PROVIDER_TIMEOUT_MS = Math.max(5000, Number(process.env.PROVIDER_TIMEOUT_MS || 22000));
const REVENUE_PROVIDER_TIMEOUT_MS = Math.max(5000, Number(process.env.REVENUE_PROVIDER_TIMEOUT_MS || 18000));
const MAX_FAILOVER_MODELS = Math.max(1, Math.min(5, Number(process.env.MAX_FAILOVER_MODELS || 2)));

const metrics = {
  requests: 0, successes: 0, failures: 0, repairs: 0, failovers: 0, totalMs: 0,
  calls: 0, inputTokens: 0, outputTokens: 0,
  byDomain: {}, byDepth: {}, byModel: {}, byApiKey: {}, providerFailures: {}
};
const modelPerformance = new Map();
const executionIndex = new Map();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function openAIExecutionModels() {
  if (!process.env.OPENAI_API_KEY) return [];
  const legacy = process.env.AGENT_MODEL;
  if (legacy && !process.env.OPENAI_SOL_MODEL && !process.env.OPENAI_TERRA_MODEL && !process.env.OPENAI_LUNA_MODEL) {
    return [{
      id: `openai:${legacy}`, provider: "openai", model: legacy, enabled: true,
      strengths: ["general", "business", "research", "writing", "coding", "career"],
      quality: envNumber("OPENAI_QUALITY_SCORE", 0.92), speed: envNumber("OPENAI_SPEED_SCORE", 0.72), cost: envNumber("OPENAI_COST_SCORE", 0.45)
    }];
  }
  return [
    {
      id: `openai:${process.env.OPENAI_SOL_MODEL || "gpt-5.6-sol"}`, provider: "openai",
      model: process.env.OPENAI_SOL_MODEL || "gpt-5.6-sol", enabled: process.env.OPENAI_SOL_ENABLED !== "false",
      strengths: ["general", "business", "research", "writing", "coding", "career"],
      quality: envNumber("OPENAI_SOL_QUALITY_SCORE", 0.98), speed: envNumber("OPENAI_SOL_SPEED_SCORE", 0.58), cost: envNumber("OPENAI_SOL_COST_SCORE", 0.18)
    },
    {
      id: `openai:${process.env.OPENAI_TERRA_MODEL || "gpt-5.6-terra"}`, provider: "openai",
      model: process.env.OPENAI_TERRA_MODEL || "gpt-5.6-terra", enabled: process.env.OPENAI_TERRA_ENABLED !== "false",
      strengths: ["general", "business", "research", "writing", "coding", "career"],
      quality: envNumber("OPENAI_TERRA_QUALITY_SCORE", 0.92), speed: envNumber("OPENAI_TERRA_SPEED_SCORE", 0.76), cost: envNumber("OPENAI_TERRA_COST_SCORE", 0.52)
    },
    {
      id: `openai:${process.env.OPENAI_LUNA_MODEL || "gpt-5.6-luna"}`, provider: "openai",
      model: process.env.OPENAI_LUNA_MODEL || "gpt-5.6-luna", enabled: process.env.OPENAI_LUNA_ENABLED !== "false",
      strengths: ["general", "business", "writing", "career"],
      quality: envNumber("OPENAI_LUNA_QUALITY_SCORE", 0.78), speed: envNumber("OPENAI_LUNA_SPEED_SCORE", 0.96), cost: envNumber("OPENAI_LUNA_COST_SCORE", 0.96)
    }
  ].filter(model => model.enabled);
}

function modelRegistry() {
  const models = openAIExecutionModels();
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_MODEL) models.push({
    id: `anthropic:${process.env.ANTHROPIC_MODEL}`,
    provider: "anthropic", model: process.env.ANTHROPIC_MODEL, enabled: true,
    strengths: (process.env.ANTHROPIC_STRENGTHS || "writing,research,coding,general").split(",").map(v => v.trim()).filter(Boolean),
    quality: envNumber("ANTHROPIC_QUALITY_SCORE", 0.9), speed: envNumber("ANTHROPIC_SPEED_SCORE", 0.68), cost: envNumber("ANTHROPIC_COST_SCORE", 0.5)
  });
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_MODEL) models.push({
    id: `gemini:${process.env.GEMINI_MODEL}`,
    provider: "gemini", model: process.env.GEMINI_MODEL, enabled: true,
    strengths: (process.env.GEMINI_STRENGTHS || "research,general,coding,business").split(",").map(v => v.trim()).filter(Boolean),
    quality: envNumber("GEMINI_QUALITY_SCORE", 0.87), speed: envNumber("GEMINI_SPEED_SCORE", 0.82), cost: envNumber("GEMINI_COST_SCORE", 0.7)
  });
  return models.filter(model => model.enabled);
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  return (payload?.output || []).flatMap(item => item?.content || []).map(part => part?.text || part?.value || "").filter(Boolean).join("\n").trim();
}
function parseJson(text) {
  const cleaned = text.replace(/^\s*```json\s*/i, "").replace(/^\s*```\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  try { return JSON.parse(cleaned); } catch {
    const a = cleaned.indexOf("{"); const b = cleaned.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(cleaned.slice(a, b + 1));
    throw new Error("Model returned invalid JSON.");
  }
}
function normalizeUsage(usage = {}) { return { input_tokens: Number(usage.input_tokens || usage.prompt_tokens || usage.inputTokens || 0), output_tokens: Number(usage.output_tokens || usage.completion_tokens || usage.outputTokens || 0) }; }
async function fetchWithTimeout(url, options = {}, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (error) { if (error?.name === "AbortError") throw new Error(`Provider timed out after ${timeoutMs}ms`); throw error; }
  finally { clearTimeout(timer); }
}
async function callOpenAI({ model, prompt, effort = "low", maxOutputTokens = 2200, timeoutMs = PROVIDER_TIMEOUT_MS }) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured.");
  const response = await fetchWithTimeout("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, input: prompt, reasoning: { effort }, max_output_tokens: maxOutputTokens, store: false }) }, timeoutMs);
  const payload = await response.json(); if (!response.ok) throw new Error(payload?.error?.message || `OpenAI request failed with HTTP ${response.status}`);
  const text = extractOutputText(payload); if (!text) throw new Error("OpenAI returned no text."); return { text, usage: normalizeUsage(payload?.usage) };
}
async function callAnthropic({ model, prompt, maxOutputTokens = 2200 }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured.");
  const response = await fetchWithTimeout("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model, max_tokens: maxOutputTokens, messages: [{ role: "user", content: prompt }] }) });
  const payload = await response.json(); if (!response.ok) throw new Error(payload?.error?.message || `Anthropic request failed with HTTP ${response.status}`);
  const text = (payload?.content || []).map(part => part?.text || "").filter(Boolean).join("\n").trim(); if (!text) throw new Error("Anthropic returned no text."); return { text, usage: normalizeUsage(payload?.usage) };
}
async function callGemini({ model, prompt, maxOutputTokens = 2200 }) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured.");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const response = await fetchWithTimeout(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens } }) });
  const payload = await response.json(); if (!response.ok) throw new Error(payload?.error?.message || `Gemini request failed with HTTP ${response.status}`);
  const text = (payload?.candidates?.[0]?.content?.parts || []).map(part => part?.text || "").filter(Boolean).join("\n").trim(); if (!text) throw new Error("Gemini returned no text."); return { text, usage: normalizeUsage(payload?.usageMetadata) };
}
async function callProvider({ provider, model, prompt, effort = "low", maxOutputTokens = 2200, timeoutMs = PROVIDER_TIMEOUT_MS }) {
  const started = Date.now(); let result;
  try { if (provider === "openai") result = await callOpenAI({ model, prompt, effort, maxOutputTokens, timeoutMs }); else if (provider === "anthropic") result = await callAnthropic({ model, prompt, maxOutputTokens }); else if (provider === "gemini") result = await callGemini({ model, prompt, maxOutputTokens }); else throw new Error(`Unsupported provider: ${provider}`); }
  catch (error) { metrics.providerFailures[provider] = (metrics.providerFailures[provider] || 0) + 1; throw error; }
  const ms = Date.now() - started; metrics.calls++; metrics.inputTokens += result.usage.input_tokens; metrics.outputTokens += result.usage.output_tokens; return { ...result, ms, provider, model };
}
function performanceKey(modelId, domain, depth) { return `${modelId}|${domain}|${depth}`; }
function defaultPerformance() { return { attempts: 0, successes: 0, failures: 0, repairs: 0, feedbackTotal: 0, feedbackCount: 0, avgMs: 0 }; }
function getPerformance(modelId, domain, depth) { return modelPerformance.get(performanceKey(modelId, domain, depth)) || defaultPerformance(); }
function persistPerformance(modelId, domain, depth) { if (!storageEnabled()) return; const routeKey = performanceKey(modelId, domain, depth); saveRoutePerformance({ routeKey, modelId, domain, depth, performance: modelPerformance.get(routeKey) || defaultPerformance() }).catch(error => console.error("Failed to persist route performance:", error.message)); }
function updatePerformance({ modelId, domain, depth, success, repaired, ms }) {
  const key = performanceKey(modelId, domain, depth); const current = getPerformance(modelId, domain, depth); const attempts = current.attempts + 1;
  modelPerformance.set(key, { ...current, attempts, successes: current.successes + (success ? 1 : 0), failures: current.failures + (success ? 0 : 1), repairs: current.repairs + (repaired ? 1 : 0), avgMs: Math.round(((current.avgMs * current.attempts) + Number(ms || 0)) / attempts) }); persistPerformance(modelId, domain, depth);
}
function addFeedback(modelId, domain, depth, score) { const key = performanceKey(modelId, domain, depth); const current = getPerformance(modelId, domain, depth); modelPerformance.set(key, { ...current, feedbackTotal: current.feedbackTotal + score, feedbackCount: current.feedbackCount + 1 }); persistPerformance(modelId, domain, depth); }
function learnedScore(modelId, domain, depth) { const p = getPerformance(modelId, domain, depth); if (!p.attempts && !p.feedbackCount) return 0.5; const successRate = p.attempts ? p.successes / p.attempts : 0.5; const feedback = p.feedbackCount ? p.feedbackTotal / p.feedbackCount / 5 : 0.5; const repairPenalty = p.attempts ? (p.repairs / p.attempts) * 0.15 : 0; return Math.max(0, Math.min(1, successRate * 0.6 + feedback * 0.4 - repairPenalty)); }
function selectExecutionModel(route, requestedModel = "") {
  const models = modelRegistry(); if (!models.length) throw new Error("No execution model provider is configured.");
  if (requestedModel) { const forced = models.find(model => model.id === requestedModel || model.model === requestedModel); if (!forced) throw new Error(`Requested model is not configured: ${requestedModel}`); return { selected: forced, reason: "explicit_model_request", candidates: [forced], allowFailover: false }; }
  const weights = ROUTING_POLICY === "quality" ? { quality: 0.55, speed: 0.1, cost: 0.05, learned: 0.3 } : ROUTING_POLICY === "cost" ? { quality: 0.2, speed: 0.15, cost: 0.4, learned: 0.25 } : { quality: 0.35, speed: 0.15, cost: 0.2, learned: 0.3 };
  const candidates = models.map(model => { const domainFit = model.strengths.includes(route.domain) ? 1 : 0.72; const learned = learnedScore(model.id, route.domain, route.depth); const routingScore = Number((domainFit * (model.quality * weights.quality + model.speed * weights.speed + model.cost * weights.cost + learned * weights.learned)).toFixed(4)); return { ...model, learned, domainFit, routingScore }; }).sort((a, b) => b.routingScore - a.routingScore);
  return { selected: candidates[0], reason: `adaptive_${ROUTING_POLICY}`, candidates, allowFailover: true };
}
function specialistProfile(domain) { return ({ business: "sharp SaaS/business operator", research: "rigorous research lead", writing: "expert writing director", coding: "senior software architect", career: "career strategy specialist", revenue: "evidence-driven revenue opportunity orchestrator", general: "high-level execution specialist" })[domain] || "high-level execution specialist"; }
function techRevenueInstructions(request, route) {
  if (route.domain !== "revenue") return "";
  const techIntent = /tech|software|saas|app|website|api|integration|automation|deploy|bug|code|data|ai|computer/i.test(request);
  if (!techIntent) return "";
  return `\nTECH HUNTER:\n${JSON.stringify(techHunterInstructions)}\nDEAL QUALIFIER:\n${JSON.stringify(dealQualifierInstructions)}\nTECH FIXER:\n${JSON.stringify(techFixerInstructions)}\nEXECUTION AGENT:\n${JSON.stringify(executionAgentInstructions)}\nWhen the user explicitly asks to build/create/execute a credential-free prebuild for a PASS opportunity, YOU ARE THE CODE GENERATOR, NOT THE FILESYSTEM RUNNER. Do not refuse because you personally lack a shell or writable filesystem. Your job is to generate the complete exact file contents; Oracle's server-side artifact workspace will materialize and test them after your response. End the response with a machine-readable fenced JSON block whose opening line is exactly \`\`\`json ORACLE_ARTIFACTS and whose body matches {"opportunity":"short-name","files":[{"path":"relative/path","content":"exact complete file contents"}],"testCommands":[["node","--test"]]}. The block is an instruction to Oracle's trusted local workspace runner, not a claim that you created or tested anything yourself. CRITICAL OUTPUT CONTRACT: after your human-readable explanation, you MUST include the ORACLE_ARTIFACTS block. Ordinary markdown file sections are not enough and will not execute. Do not say execution is blocked if you can generate the file contents. IMPORTANT: never say the session lacks artifact-workspace access, filesystem access, shell tools, repository files, runtime/build commands, acceptance criteria, or a test suite. For a credential-free prototype, YOU must choose a minimal reasonable prototype specification, runtime, API contract, acceptance criteria, file set, and tests from the qualified opportunity and labeled assumptions. The downstream runner supplies filesystem/test execution after you emit ORACLE_ARTIFACTS. Missing buyer-specific details are not blockers for a generic prebuild; use safe labeled assumptions and build the smallest demonstrable vertical slice. Keep it under 30 files and 250KB. Do not emit this block for ordinary opportunity scans. Never report tests as passed yourself; the server will append real execution results.\nREVENUE HANDOFF: After feasibility, identify pricing inputs and the next authorized action. Do not claim outreach, delivery, or revenue unless it actually occurred.`;
}

function revenueInstructions(request, route) {
  if (route.domain !== "revenue") return "";
  return `
REVENUE PIPELINE ACTIVE.
You are Oracle coordinating these internal agents in sequence:
1. ${opportunityFinder.id}: discover legitimate product/service/digital/lead opportunities and distinguish evidence from hypotheses.
2. validate-demand: test whether a real buyer problem and plausible demand exist.
3. validate-supply: identify a legitimate supply/fulfillment path without inventing suppliers.
4. unit-economics: estimate acquisition cost, sale value, fees and margin; label unknowns.
5. ${buyerMatcher.id}: define likely buyer segments, qualification signals, where genuine intent can be found, and the offer angle.
6. ${dealOrchestrator.id}: choose the next executable steps and define how outcomes will be tracked.

Required stages: ${dealOrchestrator.stages.join(", ")}.
Do not claim live web research, named buyers, suppliers, outreach, transactions, or sales unless those actions/data were actually available to this execution. No spam, deception, impersonation, fake scarcity, or platform-rule evasion. Payments, contracts, purchases, listings, messages, and consequential account actions require explicit authorization before execution. Optimize for validated profitable transactions, not busywork.
Return a useful operator-facing result: strongest opportunity candidates, evidence/unknowns, buyer match, economics, risks, and the next concrete validation/execution step.`;
}
async function routeWithOracle(request) {
  const result = await callProvider({ provider: "openai", model: ROUTER_MODEL, maxOutputTokens: 450, prompt: `You are Oracle Router. Classify the request and choose the MINIMUM depth needed. Return ONLY JSON: {"domain":"business|research|writing|coding|career|revenue|general","task":"short task","goal":"desired result","complexity":"simple|standard|advanced","depth":"light|normal|deep"}. Use revenue when the user wants to make money by finding something to sell, sourcing/fulfilling an offer, finding or matching buyers, brokering supply and demand, generating deal flow, or coordinating a sale/revenue workflow. Light = straightforward. Normal = meaningful multi-step. Deep = genuinely difficult/high-stakes. USER REQUEST:\n${request}` });
  const route = parseJson(result.text); route.domain = SPECIALISTS.has(String(route.domain).toLowerCase()) ? String(route.domain).toLowerCase() : "general"; route.depth = DEPTHS.has(String(route.depth).toLowerCase()) ? String(route.depth).toLowerCase() : "normal"; return { route, call: result };
}
async function execute({ request, route, executionModel, repair = "", marketEvidence = null }) {
  const limits = route.depth === "light" ? { tokens: 1200, length: "Prefer a concise answer, usually under 500 words unless the task inherently requires more." } : route.depth === "deep" ? { tokens: 3600, length: "Use necessary depth, but aggressively remove repetition and filler." } : { tokens: 2400, length: "Aim for a practical answer around 700-1200 words when appropriate; use less when possible." };
  return callProvider({ provider: executionModel.provider, model: executionModel.model, effort: "low", maxOutputTokens: Math.min(limits.tokens, route.domain === "revenue" ? 1200 : limits.tokens), timeoutMs: route.domain === "revenue" ? REVENUE_PROVIDER_TIMEOUT_MS : PROVIDER_TIMEOUT_MS, prompt: `You are a ${specialistProfile(route.domain)} inside Oracle Stack. Privately improve the raw request into strong execution instructions, then execute them yourself. Never expose the internal Stack. Return only the finished work.\nREQUEST:\n${request}\nROUTE:\n${JSON.stringify(route)}${repair ? `\nQA REPAIR NOTES:\n${repair}` : ""}\n${limits.length}\nPreserve intent. Do not invent facts or external actions. Make labeled assumptions for nonessential unknowns.${revenueInstructions(request, route)}${techRevenueInstructions(request, route)}${route.domain === "revenue" ? evidencePromptBlock(marketEvidence) : ""} Ask only if a truly essential detail prevents responsible execution. Prioritize concrete useful information over exhaustive text. Do not repeat the same recommendation in multiple sections.` });
}
async function judgeAnswer({ request, route, answer }) {
  const result = await callProvider({ provider: "openai", model: JUDGE_MODEL, maxOutputTokens: 400, prompt: `You are Oracle final QA. Return ONLY JSON {"pass":true,"issues":[],"repair_instructions":""}. Fail only for MATERIAL problems: not answering the request, changed intent, ignored explicit constraints, fabricated facts/actions, contradictions, or clearly unusable verbosity. Do not fail for minor style. ORIGINAL:\n${request}\nROUTE:\n${JSON.stringify(route)}\nANSWER:\n${answer}` });
  const qa = parseJson(result.text); return { qa: { pass: Boolean(qa.pass), issues: Array.isArray(qa.issues) ? qa.issues : [], repair_instructions: String(qa.repair_instructions || "") }, call: result };
}
function forcedArtifactPrompt({ request, route, marketEvidence }) {
  return `You are Oracle's artifact compiler. Generate a SMALL, COMPLETE, credential-free Node.js prototype for the qualified technical opportunity described below. You do not need filesystem, shell, repository, buyer credentials, or prior files. Choose safe labeled assumptions. Return ONLY valid JSON, no markdown, with schema {"opportunity":"short-name","files":[{"path":"relative/path","content":"exact complete file contents"}],"testCommands":[["node","--test"]]}. Include package.json, implementation, README, and tests. Maximum 12 files. Never claim tests ran; Oracle's server-side runner will run them after parsing this JSON.\nREQUEST:\n${request}\nROUTE:\n${JSON.stringify(route)}\nEVIDENCE:\n${evidencePromptBlock(marketEvidence)}`;
}
function wantsArtifactExecution(request, route) {
  return route.domain === "revenue" && /(?:execute|build|materialize|prototype|prebuild|artifact)/i.test(request) && /(?:railcall|pass|opportunit|tech|automation|backend|ai)/i.test(request);
}
async function runCandidate({ request, route, model, marketEvidence = null }) {
  const started = Date.now(); const calls = []; let repaired = false;
  try { let executed = await execute({ request, route, executionModel: model, marketEvidence }); calls.push(executed); let judged = await judgeAnswer({ request, route, answer: executed.text }); calls.push(judged.call); let answer = executed.text;
    if (!judged.qa.pass && judged.qa.repair_instructions && route.domain !== "revenue") { const repairCall = await execute({ request, route, executionModel: model, repair: judged.qa.repair_instructions, marketEvidence }); calls.push(repairCall); repaired = true; metrics.repairs++; answer = repairCall.text; judged = await judgeAnswer({ request, route, answer }); calls.push(judged.call); }
    const elapsedMs = Date.now() - started; const pass = route.domain === "revenue" ? Boolean(answer && answer.trim()) : Boolean(judged.qa.pass); updatePerformance({ modelId: model.id, domain: route.domain, depth: route.depth, success: pass, repaired, ms: elapsedMs }); return { ok: pass, answer, qa: judged.qa, repaired, calls, elapsedMs, error: pass ? null : "QA failed after repair" };
  } catch (error) { const elapsedMs = Date.now() - started; updatePerformance({ modelId: model.id, domain: route.domain, depth: route.depth, success: false, repaired, ms: elapsedMs }); return { ok: false, answer: "", qa: { pass: false, issues: [error.message], repair_instructions: "" }, repaired, calls, elapsedMs, error: error.message }; }
}
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "oracle-stack", mode: "adaptive-multi-model-execution", liveMarketDiscovery: discoveryEnabled(), routingPolicy: ROUTING_POLICY, persistence: storageEnabled() ? "postgres" : "memory", developerApi: apiAuthEnabled() ? "enabled" : "disabled", failover: { enabled: true, maxModels: MAX_FAILOVER_MODELS, providerTimeoutMs: PROVIDER_TIMEOUT_MS, revenueProviderTimeoutMs: REVENUE_PROVIDER_TIMEOUT_MS, revenueHedging: true, revenueHedgeDelayMs: Math.max(1000, Number(process.env.REVENUE_HEDGE_DELAY_MS || 5000)) }, providers: [...new Set(modelRegistry().map(model => model.provider))], models: modelRegistry().map(model => ({ id: model.id, provider: model.provider, model: model.model })) }));
app.get("/api/models", (_req, res) => { const models = modelRegistry().map(({ id, provider, model, strengths, quality, speed, cost }) => ({ id, provider, model, strengths, quality, speed, cost })); res.json({ policy: ROUTING_POLICY, models }); });
app.get("/api/metrics", async (_req, res) => { let persistentUsage = null; try { persistentUsage = await getUsageSummary(30); } catch (error) { console.error("Usage summary failed:", error.message); } res.json({ ...metrics, avgMs: metrics.successes ? Math.round(metrics.totalMs / metrics.successes) : 0, avgCalls: metrics.requests ? Number((metrics.calls / metrics.requests).toFixed(2)) : 0, persistence: storageEnabled() ? "postgres" : "memory", persistentUsage30d: persistentUsage, learnedRoutes: [...modelPerformance.entries()].map(([key, value]) => ({ key, ...value })) }); });
app.get("/v1/usage", requireApiKey, async (req, res) => { const apiKeyId = req.oracleApiKeyId; const inMemory = metrics.byApiKey[apiKeyId] || { executions: 0, totalTokens: 0 }; let persistent = null; try { persistent = await getUsageSummary(30, apiKeyId); } catch (error) { console.error("API usage lookup failed:", error.message); } res.json({ apiKeyId, windowDays: 30, quota: quotaSnapshot(apiKeyId), currentProcess: inMemory, persistent }); });
app.post("/api/feedback", async (req, res) => { const executionId = String(req.body?.executionId || "").trim(); const score = Number(req.body?.score); if (!executionId) return res.status(400).json({ error: "executionId is required." }); if (!Number.isFinite(score) || score < 1 || score > 5) return res.status(400).json({ error: "score must be between 1 and 5." }); let execution = executionIndex.get(executionId); if (!execution && storageEnabled()) { const row = await findExecution(executionId); if (row) execution = { modelId: row.model_id, domain: row.domain, depth: row.depth }; } if (!execution) return res.status(404).json({ error: "Unknown executionId." }); addFeedback(execution.modelId, execution.domain, execution.depth, score); if (storageEnabled()) await saveFeedback(executionId, score); res.json({ ok: true, executionId, score }); });
async function oracleHandler(req, res) {
  const requestStarted = Date.now(); const executionId = crypto.randomUUID(); const apiKeyId = req.oracleApiKeyId || null; metrics.requests++; let route = null; let finalModel = null;
  try { const request = String(req.body?.request || "").trim(); const requestedModel = String(req.body?.model || "").trim(); if (!request) return res.status(400).json({ error: "Request is required." });
    let effectiveRequest = request;
    let contextCompacted = false;
    if (request.length > 12000) {
      effectiveRequest = `EARLIER CONTEXT:\n${request.slice(0, 3500)}\n\n[older middle context omitted by Oracle]\n\nLATEST CONTEXT AND INSTRUCTIONS:\n${request.slice(-8000)}`;
      contextCompacted = true;
    }
    const routed = await routeWithOracle(effectiveRequest); route = routed.route; metrics.byDomain[route.domain] = (metrics.byDomain[route.domain] || 0) + 1; metrics.byDepth[route.depth] = (metrics.byDepth[route.depth] || 0) + 1;
    const marketEvidence = route.domain === "revenue" ? await discoverMarketEvidence(effectiveRequest) : null;
    const decision = selectExecutionModel(route, requestedModel); const candidates = decision.allowFailover ? decision.candidates.slice(0, MAX_FAILOVER_MODELS) : decision.candidates; const attempts = []; let result = null;
    if (route.domain === "revenue" && decision.allowFailover && candidates.length > 1) {
      const hedgeDelayMs = Math.max(1000, Number(process.env.REVENUE_HEDGE_DELAY_MS || 5000));
      const jobs = candidates.map((model, index) => (async () => {
        if (index) await new Promise(resolve => setTimeout(resolve, hedgeDelayMs * index));
        metrics.byModel[model.id] = (metrics.byModel[model.id] || 0) + 1;
        if (index) metrics.failovers++;
        const candidateResult = await runCandidate({ request: effectiveRequest, route, model, marketEvidence });
        attempts.push({ modelId: model.id, provider: model.provider, model: model.model, routingScore: model.routingScore ?? null, ok: candidateResult.ok, repaired: candidateResult.repaired, elapsedMs: candidateResult.elapsedMs, error: candidateResult.error, hedged: index > 0 });
        if (!candidateResult.ok) throw new Error(candidateResult.error || `${model.id} failed`);
        return { model, candidateResult };
      })());
      try {
        const winner = await Promise.any(jobs);
        result = winner.candidateResult; finalModel = winner.model;
      } catch {
        // All hedged candidates failed; the aggregate error is replaced below with useful per-model detail.
      }
    } else {
      for (let index = 0; index < candidates.length; index++) { const model = candidates[index]; metrics.byModel[model.id] = (metrics.byModel[model.id] || 0) + 1; const candidateResult = await runCandidate({ request: effectiveRequest, route, model, marketEvidence }); attempts.push({ modelId: model.id, provider: model.provider, model: model.model, routingScore: model.routingScore ?? null, ok: candidateResult.ok, repaired: candidateResult.repaired, elapsedMs: candidateResult.elapsedMs, error: candidateResult.error, hedged: false }); if (candidateResult.ok) { result = candidateResult; finalModel = model; break; } if (index < candidates.length - 1 && decision.allowFailover) metrics.failovers++; }
    }
    if (!result || !finalModel) throw new Error(`All execution routes failed: ${attempts.map(a => `${a.modelId}: ${a.error}`).join(" | ")}`);
    let artifactRun = null;
    if (wantsArtifactExecution(effectiveRequest, route)) {
      try {
        const artifactCall = await callProvider({ provider: finalModel.provider, model: finalModel.model, effort: "low", maxOutputTokens: 5000, timeoutMs: REVENUE_PROVIDER_TIMEOUT_MS, prompt: forcedArtifactPrompt({ request: effectiveRequest, route, marketEvidence }) });
        const spec = parseJson(artifactCall.text);
        artifactRun = await materializeExecutionArtifacts(spec);
        result.answer = result.answer.trim() + "\n\n## Execution workspace\n" + JSON.stringify(artifactRun, null, 2);
      } catch (error) {
        artifactRun = { status: "QA_FAILED", error: error.message };
        result.answer = result.answer.trim() + "\n\n## Execution workspace\n" + JSON.stringify(artifactRun, null, 2);
      }
    } else if (route.domain === "revenue") {
      const match = result.answer.match(/\`\`\`(?:json)?\\s*ORACLE_ARTIFACTS\\s*([\\s\\S]*?)\`\`\`/i)
        || result.answer.match(/ORACLE_ARTIFACTS\\s*([\\{][\\s\\S]*?[\\}])\\s*$/i);
      if (match) {
        try {
          const spec = JSON.parse(match[1]);
          artifactRun = await materializeExecutionArtifacts(spec);
          result.answer = result.answer.replace(match[0], "").trim() + "\n\n## Execution workspace\n" + JSON.stringify(artifactRun, null, 2);
        } catch (error) {
          artifactRun = { status: "QA_FAILED", error: error.message };
          result.answer = result.answer.replace(match[0], "").trim() + "\n\n## Execution workspace\n" + JSON.stringify(artifactRun, null, 2);
        }
      }
    }
    const elapsedMs = Date.now() - requestStarted; metrics.successes++; metrics.totalMs += elapsedMs; const allCalls = [routed.call, ...(result.calls || [])]; const inputTokens = allCalls.reduce((n, call) => n + Number(call?.usage?.input_tokens || 0), 0); const outputTokens = allCalls.reduce((n, call) => n + Number(call?.usage?.output_tokens || 0), 0); const totalTokens = inputTokens + outputTokens;
    executionIndex.set(executionId, { modelId: finalModel.id, domain: route.domain, depth: route.depth, apiKeyId, createdAt: Date.now() }); if (executionIndex.size > 5000) executionIndex.delete(executionIndex.keys().next().value);
    if (apiKeyId) { const usage = metrics.byApiKey[apiKeyId] || { executions: 0, totalTokens: 0 }; usage.executions++; usage.totalTokens += totalTokens; metrics.byApiKey[apiKeyId] = usage; }
    const telemetry = { executionId, apiKeyId, elapsedMs, contextCompacted, originalRequestChars: request.length, effectiveRequestChars: effectiveRequest.length, modelCalls: allCalls.length, inputTokens, outputTokens, totalTokens, specialist: route.domain, depth: route.depth, repaired: result.repaired, provider: finalModel.provider, model: finalModel.model, modelId: finalModel.id, routingPolicy: ROUTING_POLICY, routingReason: attempts.length > 1 ? `${decision.reason}_failover` : decision.reason, routingScore: finalModel.routingScore ?? null, failoverCount: Math.max(0, attempts.length - 1), attemptedModels: attempts, liveDiscovery: marketEvidence ? { enabled: marketEvidence.enabled, provider: marketEvidence.provider, evidenceCount: marketEvidence.results.length } : null, artifactRun: artifactRun ? { status: artifactRun.status, fileCount: artifactRun.files?.length || 0, testCount: artifactRun.tests?.length || 0 } : null };
    if (storageEnabled()) saveExecution({ ...telemetry, domain: route.domain, success: true }).catch(error => console.error("Failed to persist execution:", error.message)); console.log("ORACLE_METRIC", JSON.stringify(telemetry)); res.json({ original: request, answer: result.answer, route, model: { id: finalModel.id, provider: finalModel.provider, name: finalModel.model, reason: telemetry.routingReason }, qa: { pass: true, answerRepaired: result.repaired, issues: [] }, telemetry });
  } catch (error) { metrics.failures++; console.error("Oracle request failed:", error); res.status(500).json({ executionId, error: error?.message || "Oracle Stack failed to process the request." }); }
}
app.post("/api/oracle", oracleHandler); app.post("/v1/oracle", requireApiKey, oracleHandler);
async function start() { try { const state = await initStorage(); if (state.enabled) { const rows = await loadRoutePerformance(); for (const row of rows) modelPerformance.set(row.route_key, { attempts: Number(row.attempts || 0), successes: Number(row.successes || 0), failures: Number(row.failures || 0), repairs: Number(row.repairs || 0), feedbackTotal: Number(row.feedback_total || 0), feedbackCount: Number(row.feedback_count || 0), avgMs: Number(row.avg_ms || 0) }); console.log(`Oracle loaded ${rows.length} learned routes from Postgres.`); } else console.log("Oracle persistence: in-memory mode (DATABASE_URL not configured)."); } catch (error) { console.error("Oracle persistence unavailable; continuing in memory:", error.message); } app.listen(PORT, () => console.log(`Oracle Stack listening on port ${PORT}`)); }
start();
