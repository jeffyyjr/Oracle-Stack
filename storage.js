import pg from "pg";

const { Pool } = pg;
let pool = null;
let enabled = false;

export function storageEnabled() { return enabled; }

export async function initStorage() {
  if (!process.env.DATABASE_URL) return { enabled: false };
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oracle_route_performance (
      route_key TEXT PRIMARY KEY, model_id TEXT NOT NULL, domain TEXT NOT NULL, depth TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0, repairs INTEGER NOT NULL DEFAULT 0,
      feedback_total DOUBLE PRECISION NOT NULL DEFAULT 0, feedback_count INTEGER NOT NULL DEFAULT 0,
      avg_ms INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS oracle_executions (
      execution_id UUID PRIMARY KEY, api_key_id TEXT, model_id TEXT NOT NULL, provider TEXT NOT NULL,
      model TEXT NOT NULL, domain TEXT NOT NULL, depth TEXT NOT NULL, routing_policy TEXT,
      routing_reason TEXT, routing_score DOUBLE PRECISION, success BOOLEAN NOT NULL,
      repaired BOOLEAN NOT NULL DEFAULT FALSE, elapsed_ms INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0, feedback_score DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE oracle_executions ADD COLUMN IF NOT EXISTS api_key_id TEXT;
    CREATE INDEX IF NOT EXISTS oracle_executions_created_at_idx ON oracle_executions(created_at DESC);
    CREATE INDEX IF NOT EXISTS oracle_executions_api_key_idx ON oracle_executions(api_key_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS oracle_artifacts (
      workspace_id TEXT PRIMARY KEY,
      opportunity TEXT NOT NULL,
      status TEXT NOT NULL,
      manifest JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS oracle_artifact_files (
      workspace_id TEXT NOT NULL REFERENCES oracle_artifacts(workspace_id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, path)
    );
    CREATE TABLE IF NOT EXISTS oracle_artifact_runs (
      id BIGSERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES oracle_artifacts(workspace_id) ON DELETE CASCADE,
      command TEXT NOT NULL,
      exit_code INTEGER,
      stdout TEXT NOT NULL DEFAULT '',
      stderr TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS oracle_artifacts_created_at_idx ON oracle_artifacts(created_at DESC);
    CREATE INDEX IF NOT EXISTS oracle_artifact_runs_workspace_idx ON oracle_artifact_runs(workspace_id, id);
  `);
  enabled = true;
  return { enabled: true };
}

export async function loadRoutePerformance() {
  if (!enabled) return [];
  const result = await pool.query(`SELECT route_key, model_id, domain, depth, attempts, successes, failures, repairs, feedback_total, feedback_count, avg_ms FROM oracle_route_performance`);
  return result.rows;
}

export async function saveRoutePerformance({ routeKey, modelId, domain, depth, performance }) {
  if (!enabled) return;
  await pool.query(`
    INSERT INTO oracle_route_performance (route_key,model_id,domain,depth,attempts,successes,failures,repairs,feedback_total,feedback_count,avg_ms,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
    ON CONFLICT (route_key) DO UPDATE SET attempts=EXCLUDED.attempts,successes=EXCLUDED.successes,failures=EXCLUDED.failures,
    repairs=EXCLUDED.repairs,feedback_total=EXCLUDED.feedback_total,feedback_count=EXCLUDED.feedback_count,avg_ms=EXCLUDED.avg_ms,updated_at=NOW()
  `, [routeKey,modelId,domain,depth,performance.attempts,performance.successes,performance.failures,performance.repairs,performance.feedbackTotal,performance.feedbackCount,performance.avgMs]);
}

export async function saveExecution(execution) {
  if (!enabled) return;
  await pool.query(`
    INSERT INTO oracle_executions (execution_id,api_key_id,model_id,provider,model,domain,depth,routing_policy,routing_reason,routing_score,success,repaired,elapsed_ms,input_tokens,output_tokens,total_tokens)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (execution_id) DO NOTHING
  `, [execution.executionId,execution.apiKeyId||null,execution.modelId,execution.provider,execution.model,execution.domain,execution.depth,execution.routingPolicy,execution.routingReason,execution.routingScore,execution.success,execution.repaired,execution.elapsedMs,execution.inputTokens,execution.outputTokens,execution.totalTokens]);
}

export async function findExecution(executionId) {
  if (!enabled) return null;
  const result=await pool.query(`SELECT execution_id,api_key_id,model_id,domain,depth FROM oracle_executions WHERE execution_id=$1`,[executionId]);
  return result.rows[0]||null;
}

export async function saveFeedback(executionId, score) {
  if (!enabled) return;
  await pool.query(`UPDATE oracle_executions SET feedback_score=$2 WHERE execution_id=$1`,[executionId,score]);
}

export async function getUsageSummary(days=30, apiKeyId=null) {
  if (!enabled) return null;
  const values=[String(days)]; const keyFilter=apiKeyId?"AND api_key_id = $2":"";
  if(apiKeyId) values.push(apiKeyId);
  const result=await pool.query(`
    SELECT COUNT(*)::int AS executions,COALESCE(SUM(total_tokens),0)::bigint AS total_tokens,
    COALESCE(AVG(elapsed_ms),0)::int AS avg_ms,COALESCE(AVG(feedback_score),0)::double precision AS avg_feedback,
    COALESCE(SUM(CASE WHEN success THEN 1 ELSE 0 END),0)::int AS successes,
    COALESCE(SUM(CASE WHEN repaired THEN 1 ELSE 0 END),0)::int AS repairs
    FROM oracle_executions WHERE created_at >= NOW() - ($1::text || ' days')::interval ${keyFilter}
  `,values);
  return result.rows[0];
}

export async function saveArtifactBundle({ workspaceId, opportunity, status, manifest, files, tests }) {
  if (!enabled) return false;
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO oracle_artifacts (workspace_id,opportunity,status,manifest)
      VALUES ($1,$2,$3,$4::jsonb)
      ON CONFLICT (workspace_id) DO UPDATE SET opportunity=EXCLUDED.opportunity,status=EXCLUDED.status,manifest=EXCLUDED.manifest
    `,[workspaceId,opportunity,status,JSON.stringify(manifest)]);
    for(const file of files) {
      await client.query(`
        INSERT INTO oracle_artifact_files (workspace_id,path,content,byte_size)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (workspace_id,path) DO UPDATE SET content=EXCLUDED.content,byte_size=EXCLUDED.byte_size
      `,[workspaceId,file.path,file.content,Buffer.byteLength(file.content)]);
    }
    await client.query("DELETE FROM oracle_artifact_runs WHERE workspace_id=$1",[workspaceId]);
    for(const test of tests) {
      await client.query(`INSERT INTO oracle_artifact_runs (workspace_id,command,exit_code,stdout,stderr) VALUES ($1,$2,$3,$4,$5)`,
        [workspaceId,test.command,test.code,test.stdout||"",test.stderr||""]);
    }
    await client.query("COMMIT");
    return true;
  } catch(error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function listArtifacts(limit=20) {
  if (!enabled) return [];
  const n=Math.max(1,Math.min(100,Number(limit)||20));
  const result=await pool.query(`
    SELECT workspace_id,opportunity,status,manifest,created_at
    FROM oracle_artifacts ORDER BY created_at DESC LIMIT $1
  `,[n]);
  return result.rows;
}

export async function loadArtifactBundle(workspaceId) {
  if (!enabled) return null;
  const artifact=await pool.query(`SELECT workspace_id,opportunity,status,manifest,created_at FROM oracle_artifacts WHERE workspace_id=$1`,[workspaceId]);
  if (!artifact.rows[0]) return null;
  const files=await pool.query(`SELECT path,content,byte_size FROM oracle_artifact_files WHERE workspace_id=$1 ORDER BY path`,[workspaceId]);
  const runs=await pool.query(`SELECT command,exit_code,stdout,stderr,created_at FROM oracle_artifact_runs WHERE workspace_id=$1 ORDER BY id`,[workspaceId]);
  return {...artifact.rows[0],files:files.rows,tests:runs.rows};
}
