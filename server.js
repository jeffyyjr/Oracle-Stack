import "dotenv/config";\nimport express from "express";
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

const SPECIALISTS = new Set([
  "business",
  "research",
  "writing",
  "coding",
  "career",
  "general",
]);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function extractOutputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  return (payload?.output || [])
    .flatMap((item) => item?.content || [])
    .map((part) => part?.text || part?.value || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseJson(text) {
  const cleaned = text
    .replace(/^\s*```json\s*/i, "")
    .replace(/^\s*```\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(cleaned.slice(first, last + 1));
    }
    throw new Error("Model returned invalid JSON.");
  }
}

async function callModel({ model, prompt, effort = "low", maxOutputTokens = 1800 }) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: prompt,
      reasoning: { effort },
      max_output_tokens: maxOutputTokens,
      store: false,
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    const message =
      payload?.error?.message ||
      `OpenAI request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  const text = extractOutputText(payload);
  if (!text) throw new Error("Model returned no text.");
  return text;
}

async function routeWithOracle(request) {
  const prompt = `
You are Oracle, the routing layer of Oracle Stack.

Your job is NOT to answer the user's task. Analyze it and decide which specialist should build the upgraded instruction.

Allowed domains:
- business: strategy, product, marketing, operations, entrepreneurship, finance workflows
- research: investigation, comparison, synthesis, evidence gathering
- writing: books, posts, scripts, editing, creative or professional writing
- coding: software, debugging, architecture, APIs, automation
- career: resumes, applications, interviews, job search, workplace communication
- general: everything else

Return ONLY valid JSON with this exact shape:
{
  "domain": "business|research|writing|coding|career|general",
  "task": "short description of what the user wants done",
  "goal": "the desired end result",
  "constraints": ["important constraint"],
  "missing_information": ["only details that materially affect execution"],
  "complexity": "simple|standard|advanced",
  "notes": "brief routing note"
}

Rules:
- Preserve the user's actual intent.
- Do not invent constraints or preferences.
- If the request is already clear, missing_information can be empty.
- Choose exactly one domain.
- Keep every field concise.

USER REQUEST:
${request}
`;

  const raw = await callModel({
    model: ORACLE_MODEL,
    prompt,
    effort: "low",
    maxOutputTokens: 800,
  });

  const route = parseJson(raw);
  const domain = String(route.domain || "general").toLowerCase();
  route.domain = SPECIALISTS.has(domain) ? domain : "general";
  route.constraints = Array.isArray(route.constraints) ? route.constraints : [];
  route.missing_information = Array.isArray(route.missing_information)
    ? route.missing_information
    : [];

  return route;
}

function specialistProfile(domain) {
  const profiles = {
    business:
      "You are a sharp business operator. Optimize for practical decisions, measurable outcomes, constraints, execution sequence, and commercial usefulness.",
    research:
      "You are a rigorous research lead. Optimize for scope, source quality, evidence, uncertainty, competing explanations, and a useful synthesis.",
    writing:
      "You are an expert writing director. Optimize for audience, voice, structure, purpose, constraints, revision criteria, and a polished deliverable.",
    coding:
      "You are a senior software architect and implementation lead. Optimize for requirements, environment, architecture, edge cases, tests, security, maintainability, and a runnable result.",
    career:
      "You are a career strategy specialist. Optimize for the target role, evidence from the user's background, clarity, positioning, ATS/readability where relevant, and concrete next actions.",
    general:
      "You are a high-level task architect. Turn vague intent into a precise, useful instruction with the minimum structure needed for a strong result.",
  };

  return profiles[domain] || profiles.general;
}

async function buildStack({ request, route, repairInstructions = "" }) {
  const profile = specialistProfile(route.domain);

  const prompt = `
${profile}

You are the specialist inside Oracle Stack. Convert the user's request into an upgraded instruction that another capable AI can execute immediately.

ORIGINAL REQUEST:
${request}

ORACLE ROUTE:
${JSON.stringify(route, null, 2)}

${repairInstructions ? `JUDGE REPAIR NOTES:\n${repairInstructions}\n` : ""}

Build a "Stack" that is materially better than the original while preserving the user's intent.

Use only the sections that help:
- ROLE
- OBJECTIVE
- CONTEXT
- REQUIREMENTS
- PROCESS
- OUTPUT FORMAT
- QUALITY BAR
- ASSUMPTIONS

Rules:
- Do not answer the task itself; write the upgraded instruction.
- Do not add fake facts, credentials, budgets, deadlines, sources, or preferences.
- If a missing detail is nonessential, use a clearly labeled assumption or placeholder rather than blocking.
- If a missing detail is essential, tell the executing AI exactly what to clarify.
- Be specific enough to improve results, but do not bury a simple request under unnecessary ceremony.
- Preserve requested tone, format, tools, platform, and constraints.
- Do not make dangerous, illegal, deceptive, privacy-invasive, or manipulative requests more actionable.
- Return ONLY the finished upgraded Stack, with no preamble or commentary.
`;

  return callModel({
    model: AGENT_MODEL,
    prompt,
    effort: route.complexity === "advanced" ? "medium" : "low",
    maxOutputTokens: 2200,
  });
}

async function judgeStack({ request, route, upgraded }) {
  const prompt = `
You are Judge / QA for Oracle Stack.

Compare the upgraded Stack against the original request. Your job is to catch regressions before the user sees the result.

ORIGINAL:
${request}

ROUTE:
${JSON.stringify(route, null, 2)}

UPGRADED STACK:
${upgraded}

Return ONLY valid JSON:
{
  "pass": true,
  "issues": [],
  "repair_instructions": ""
}

Set pass=false if ANY of these are true:
- The original intent changed.
- Important constraints were lost.
- New facts, preferences, deadlines, budgets, credentials, or requirements were invented.
- The Stack answers the task instead of instructing another AI to do it.
- The Stack is bloated relative to the task.
- The output instructions are contradictory or unclear.
- The upgrade makes a dangerous, illegal, deceptive, privacy-invasive, or manipulative request more actionable.

If pass=false:
- "issues" must contain concise descriptions.
- "repair_instructions" must tell the specialist exactly what to fix.
If pass=true, issues must be [] and repair_instructions must be "".
`;

  const raw = await callModel({
    model: JUDGE_MODEL,
    prompt,
    effort: "low",
    maxOutputTokens: 700,
  });

  const result = parseJson(raw);
  return {
    pass: Boolean(result.pass),
    issues: Array.isArray(result.issues) ? result.issues : [],
    repair_instructions: String(result.repair_instructions || ""),
  };
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "oracle-stack",
    apiConfigured: Boolean(OPENAI_API_KEY),
    models: {
      oracle: ORACLE_MODEL,
      specialist: AGENT_MODEL,
      judge: JUDGE_MODEL,
    },
  });
});

app.post("/api/oracle", async (req, res) => {
  try {
    const request = String(req.body?.request || "").trim();

    if (!request) {
      return res.status(400).json({ error: "Request is required." });
    }

    if (request.length > 12000) {
      return res
        .status(400)
        .json({ error: "Request is too long for V1. Keep it under 12,000 characters." });
    }

    const route = await routeWithOracle(request);
    let upgraded = await buildStack({ request, route });
    let qa = await judgeStack({ request, route, upgraded });
    let repaired = false;

    if (!qa.pass && qa.repair_instructions) {
      upgraded = await buildStack({
        request,
        route,
        repairInstructions: qa.repair_instructions,
      });
      repaired = true;
      qa = await judgeStack({ request, route, upgraded });
    }

    res.json({
      original: request,
      upgraded,
      route,
      qa: {
        pass: qa.pass,
        issues: qa.issues,
        repaired,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error?.message || "Oracle Stack failed to process the request.",
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Oracle Stack listening on port ${PORT}`);
});
