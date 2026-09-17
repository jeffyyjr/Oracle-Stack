import "dotenv/config";
import fs from "fs/promises";

const baseUrl = (process.env.ORACLE_BENCHMARK_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");
const tasks = JSON.parse(await fs.readFile(new URL("../benchmarks/tasks.json", import.meta.url), "utf8"));

async function getModels() {
  const response = await fetch(`${baseUrl}/api/models`);
  if (!response.ok) throw new Error(`Could not load models: HTTP ${response.status}`);
  return (await response.json()).models || [];
}

async function run(task, model = "") {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/api/oracle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request: task.prompt, ...(model ? { model } : {}) })
  });
  const data = await response.json();
  return {
    taskId: task.id,
    expectedDomain: task.domain,
    requestedModel: model || "oracle-auto",
    ok: response.ok,
    error: response.ok ? null : data.error,
    selectedModel: data.model?.id || null,
    routedDomain: data.route?.domain || null,
    depth: data.route?.depth || null,
    qaPass: data.qa?.pass ?? false,
    repaired: data.telemetry?.repaired ?? false,
    elapsedMs: data.telemetry?.elapsedMs || Date.now() - started,
    totalTokens: data.telemetry?.totalTokens || 0,
    answerLength: data.answer?.length || 0
  };
}

const models = await getModels();
const requested = process.argv.slice(2);
const modelIds = requested.length ? requested : ["", ...models.map(model => model.id)];
const results = [];

console.log(`Oracle benchmark: ${tasks.length} tasks × ${modelIds.length} routes`);
for (const task of tasks) {
  for (const modelId of modelIds) {
    process.stdout.write(`${task.id} → ${modelId || "oracle-auto"} ... `);
    try {
      const result = await run(task, modelId);
      results.push(result);
      console.log(result.ok ? `${result.qaPass ? "PASS" : "QA-FLAG"} ${result.elapsedMs}ms` : `ERROR ${result.error}`);
    } catch (error) {
      results.push({ taskId: task.id, expectedDomain: task.domain, requestedModel: modelId || "oracle-auto", ok: false, error: error.message });
      console.log(`ERROR ${error.message}`);
    }
  }
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
await fs.mkdir(new URL("../benchmark-results/", import.meta.url), { recursive: true });
const output = new URL(`../benchmark-results/${timestamp}.json`, import.meta.url);
await fs.writeFile(output, JSON.stringify({ createdAt: new Date().toISOString(), baseUrl, models: modelIds, results }, null, 2));

const successful = results.filter(result => result.ok);
const summary = modelIds.map(modelId => {
  const name = modelId || "oracle-auto";
  const rows = successful.filter(result => result.requestedModel === name);
  return {
    route: name,
    runs: rows.length,
    qaPassRate: rows.length ? Number((rows.filter(r => r.qaPass).length / rows.length * 100).toFixed(1)) : 0,
    repairRate: rows.length ? Number((rows.filter(r => r.repaired).length / rows.length * 100).toFixed(1)) : 0,
    avgMs: rows.length ? Math.round(rows.reduce((n, r) => n + r.elapsedMs, 0) / rows.length) : 0,
    avgTokens: rows.length ? Math.round(rows.reduce((n, r) => n + r.totalTokens, 0) / rows.length) : 0
  };
});

console.table(summary);
console.log(`Saved raw results to ${output.pathname}`);
