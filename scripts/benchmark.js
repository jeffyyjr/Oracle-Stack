import "dotenv/config";
import fs from "fs/promises";

const baseUrl = (process.env.ORACLE_BENCHMARK_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");
const repeats = Math.max(1, Number(process.env.ORACLE_BENCHMARK_REPEATS || 1));
const tasks = JSON.parse(await fs.readFile(new URL("../benchmarks/tasks.json", import.meta.url), "utf8"));

async function getModels() {
  const response = await fetch(`${baseUrl}/api/models`);
  if (!response.ok) throw new Error(`Could not load models: HTTP ${response.status}`);
  return (await response.json()).models || [];
}

async function run(task, model = "", repeat = 1) {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/api/oracle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request: task.prompt, ...(model ? { model } : {}) })
  });
  const data = await response.json();
  const attempts = data.telemetry?.attemptedModels || [];
  return {
    taskId: task.id, repeat, expectedDomain: task.domain,
    requestedModel: model || "oracle-auto", ok: response.ok,
    error: response.ok ? null : data.error,
    selectedModel: data.model?.id || null, routedDomain: data.route?.domain || null,
    depth: data.route?.depth || null, qaPass: data.qa?.pass ?? false,
    repaired: data.telemetry?.repaired ?? false,
    elapsedMs: data.telemetry?.elapsedMs || Date.now() - started,
    totalTokens: data.telemetry?.totalTokens || 0,
    failoverCount: data.telemetry?.failoverCount || 0,
    attemptedModels: attempts.map(a => a.modelId),
    routingReason: data.telemetry?.routingReason || null,
    answerLength: data.answer?.length || 0
  };
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const models = await getModels();
const requested = process.argv.slice(2);
const modelIds = requested.length ? requested : ["", ...models.map(model => model.id)];
const results = [];
console.log(`Oracle benchmark: ${tasks.length} tasks × ${modelIds.length} routes × ${repeats} repeat(s)`);

for (let repeat = 1; repeat <= repeats; repeat++) {
  for (const task of tasks) {
    for (const modelId of modelIds) {
      process.stdout.write(`[${repeat}/${repeats}] ${task.id} → ${modelId || "oracle-auto"} ... `);
      try {
        const result = await run(task, modelId, repeat);
        results.push(result);
        console.log(result.ok ? `${result.qaPass ? "PASS" : "QA-FLAG"} ${result.elapsedMs}ms ${result.totalTokens}tok` : `ERROR ${result.error}`);
      } catch (error) {
        results.push({ taskId: task.id, repeat, expectedDomain: task.domain, requestedModel: modelId || "oracle-auto", ok: false, error: error.message });
        console.log(`ERROR ${error.message}`);
      }
    }
  }
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
await fs.mkdir(new URL("../benchmark-results/", import.meta.url), { recursive: true });
const output = new URL(`../benchmark-results/${timestamp}.json`, import.meta.url);
const successful = results.filter(r => r.ok);
const summary = modelIds.map(modelId => {
  const name = modelId || "oracle-auto";
  const all = results.filter(r => r.requestedModel === name);
  const rows = successful.filter(r => r.requestedModel === name);
  const latencies = rows.map(r => r.elapsedMs);
  return {
    route: name, runs: all.length,
    successRate: all.length ? Number((rows.length / all.length * 100).toFixed(1)) : 0,
    qaPassRate: rows.length ? Number((rows.filter(r => r.qaPass).length / rows.length * 100).toFixed(1)) : 0,
    domainAccuracy: rows.length ? Number((rows.filter(r => r.routedDomain === r.expectedDomain).length / rows.length * 100).toFixed(1)) : 0,
    repairRate: rows.length ? Number((rows.filter(r => r.repaired).length / rows.length * 100).toFixed(1)) : 0,
    failoverRate: rows.length ? Number((rows.filter(r => r.failoverCount > 0).length / rows.length * 100).toFixed(1)) : 0,
    avgMs: rows.length ? Math.round(latencies.reduce((a,b)=>a+b,0)/rows.length) : 0,
    p50Ms: percentile(latencies, 50), p95Ms: percentile(latencies, 95),
    avgTokens: rows.length ? Math.round(rows.reduce((n,r)=>n+r.totalTokens,0)/rows.length) : 0
  };
});
await fs.writeFile(output, JSON.stringify({ createdAt:new Date().toISOString(), baseUrl, repeats, models:modelIds, summary, results }, null, 2));
console.table(summary);
console.log(`Saved raw results to ${output.pathname}`);
