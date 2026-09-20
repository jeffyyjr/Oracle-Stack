import pg from "pg";
import { planInboundReply } from "./sales-force.js";

const { Pool } = pg;
let pool = null;
let enabled = false;

function safeJson(value) { return JSON.stringify(value).replaceAll(String.fromCharCode(0), "").replace(/\\u0000/gi, ""); }

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
    CREATE TABLE IF NOT EXISTS oracle_beta_requests (
      id BIGSERIAL PRIMARY KEY, email TEXT NOT NULL, name TEXT, use_case TEXT, status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS oracle_beta_requests_created_at_idx ON oracle_beta_requests(created_at DESC);
    ALTER TABLE oracle_beta_requests ADD COLUMN IF NOT EXISTS api_key_id TEXT;
    ALTER TABLE oracle_beta_requests ADD COLUMN IF NOT EXISTS api_key_hash TEXT;
    ALTER TABLE oracle_beta_requests ADD COLUMN IF NOT EXISTS quota INTEGER;
    ALTER TABLE oracle_beta_requests ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

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
    ALTER TABLE oracle_artifacts ADD COLUMN IF NOT EXISTS parent_workspace_id TEXT;
    CREATE INDEX IF NOT EXISTS oracle_artifacts_parent_idx ON oracle_artifacts(parent_workspace_id);

    CREATE TABLE IF NOT EXISTS oracle_sales_campaigns (
      id UUID PRIMARY KEY, name TEXT NOT NULL, objective TEXT NOT NULL, offer TEXT NOT NULL DEFAULT '',
      target_buyer TEXT NOT NULL DEFAULT '', constraints_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'running', outreach_mode TEXT NOT NULL DEFAULT 'draft',
      authorized_auto_outreach BOOLEAN NOT NULL DEFAULT FALSE,
      cadence_minutes INTEGER NOT NULL DEFAULT 1440, daily_run_limit INTEGER NOT NULL DEFAULT 1,
      minimum_lead_score INTEGER NOT NULL DEFAULT 55, max_leads_per_run INTEGER NOT NULL DEFAULT 8,
      minimum_price DOUBLE PRECISION, target_price DOUBLE PRECISION,
      max_discount_percent DOUBLE PRECISION NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD',
      runs_today INTEGER NOT NULL DEFAULT 0, runs_date DATE NOT NULL DEFAULT CURRENT_DATE,
      next_run_at TIMESTAMPTZ, last_run_at TIMESTAMPTZ, last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS oracle_sales_campaigns_due_idx ON oracle_sales_campaigns(status,next_run_at);
    ALTER TABLE oracle_sales_campaigns ADD COLUMN IF NOT EXISTS minimum_price DOUBLE PRECISION;
    ALTER TABLE oracle_sales_campaigns ADD COLUMN IF NOT EXISTS target_price DOUBLE PRECISION;
    ALTER TABLE oracle_sales_campaigns ADD COLUMN IF NOT EXISTS max_discount_percent DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE oracle_sales_campaigns ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'USD';
    CREATE TABLE IF NOT EXISTS oracle_sales_leads (
      id UUID PRIMARY KEY, campaign_id UUID NOT NULL REFERENCES oracle_sales_campaigns(id) ON DELETE CASCADE,
      name TEXT NOT NULL, source TEXT, source_url TEXT NOT NULL, buyer_problem TEXT, buyer_email TEXT,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb, score INTEGER NOT NULL DEFAULT 0,
      stage TEXT NOT NULL DEFAULT 'discovered', outreach_draft TEXT NOT NULL DEFAULT '',
      outreach_status TEXT NOT NULL DEFAULT 'not_sent', external_message_id TEXT,
      estimated_value DOUBLE PRECISION, estimated_margin DOUBLE PRECISION,
      actual_revenue DOUBLE PRECISION, actual_margin DOUBLE PRECISION, notes TEXT NOT NULL DEFAULT '',
      proposal_draft TEXT NOT NULL DEFAULT '', proposal_price DOUBLE PRECISION,
      proposal_currency TEXT, proposal_status TEXT NOT NULL DEFAULT 'none',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(campaign_id,source_url)
    );
    CREATE INDEX IF NOT EXISTS oracle_sales_leads_campaign_idx ON oracle_sales_leads(campaign_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS oracle_sales_leads_stage_idx ON oracle_sales_leads(stage,updated_at DESC);
    ALTER TABLE oracle_sales_leads ADD COLUMN IF NOT EXISTS buyer_email TEXT;
    ALTER TABLE oracle_sales_leads ADD COLUMN IF NOT EXISTS proposal_draft TEXT NOT NULL DEFAULT '';
    ALTER TABLE oracle_sales_leads ADD COLUMN IF NOT EXISTS proposal_price DOUBLE PRECISION;
    ALTER TABLE oracle_sales_leads ADD COLUMN IF NOT EXISTS proposal_currency TEXT;
    ALTER TABLE oracle_sales_leads ADD COLUMN IF NOT EXISTS proposal_status TEXT NOT NULL DEFAULT 'none';
    CREATE TABLE IF NOT EXISTS oracle_sales_events (
      id BIGSERIAL PRIMARY KEY, campaign_id UUID REFERENCES oracle_sales_campaigns(id) ON DELETE CASCADE,
      lead_id UUID REFERENCES oracle_sales_leads(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL, detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS oracle_sales_events_campaign_idx ON oracle_sales_events(campaign_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS oracle_sales_inbound_messages (
      provider_message_id TEXT PRIMARY KEY, in_reply_to TEXT NOT NULL,
      campaign_id UUID REFERENCES oracle_sales_campaigns(id) ON DELETE SET NULL,
      lead_id UUID REFERENCES oracle_sales_leads(id) ON DELETE SET NULL,
      classification TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'received',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS oracle_sales_inbound_reply_to_idx ON oracle_sales_inbound_messages(in_reply_to);
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

export async function getMonthlyApiUsage(apiKeyId) {
  if (!enabled) return null;
  const result=await pool.query(`
    SELECT COUNT(*)::int AS used, COALESCE(SUM(total_tokens),0)::bigint AS total_tokens
    FROM oracle_executions
    WHERE api_key_id=$1
      AND created_at >= date_trunc('month', NOW() AT TIME ZONE 'UTC')
      AND created_at < date_trunc('month', NOW() AT TIME ZONE 'UTC') + interval '1 month'
  `,[apiKeyId]);
  return result.rows[0]||{used:0,total_tokens:0};
}

export async function saveArtifactBundle({ workspaceId, opportunity, status, manifest, files, tests, parentWorkspaceId=null }) {
  if (!enabled) return false;
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO oracle_artifacts (workspace_id,opportunity,status,manifest)
      VALUES ($1,$2,$3,$4::jsonb)
      ON CONFLICT (workspace_id) DO UPDATE SET opportunity=EXCLUDED.opportunity,status=EXCLUDED.status,manifest=EXCLUDED.manifest
    `,[workspaceId,opportunity,status,safeJson(manifest)]);
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
  const artifact=await pool.query(`SELECT workspace_id,opportunity,status,manifest,parent_workspace_id,created_at FROM oracle_artifacts WHERE workspace_id=$1`,[workspaceId]);
  if (!artifact.rows[0]) return null;
  const files=await pool.query(`SELECT path,content,byte_size FROM oracle_artifact_files WHERE workspace_id=$1 ORDER BY path`,[workspaceId]);
  const runs=await pool.query(`SELECT command,exit_code,stdout,stderr,created_at FROM oracle_artifact_runs WHERE workspace_id=$1 ORDER BY id`,[workspaceId]);
  return {...artifact.rows[0],files:files.rows,tests:runs.rows};
}

export async function artifactLineage(workspaceId) {
  if (!enabled) return [];
  const result=await pool.query(`
    WITH RECURSIVE lineage AS (
      SELECT workspace_id,opportunity,status,manifest,parent_workspace_id,created_at,0 AS depth
      FROM oracle_artifacts WHERE workspace_id=$1
      UNION ALL
      SELECT a.workspace_id,a.opportunity,a.status,a.manifest,a.parent_workspace_id,a.created_at,l.depth+1
      FROM oracle_artifacts a JOIN lineage l ON a.workspace_id=l.parent_workspace_id
      WHERE l.depth < 50
    )
    SELECT * FROM lineage ORDER BY depth DESC
  `,[workspaceId]);
  return result.rows;
}

export async function latestPassingArtifact(opportunityPattern=null) {
  if (!enabled) return null;
  const values=[]; let filter="WHERE status='MATERIALIZED'";
  if(opportunityPattern){values.push(`%${opportunityPattern}%`);filter+=" AND opportunity ILIKE $1";}
  const result=await pool.query(`SELECT workspace_id,opportunity,status,manifest,parent_workspace_id,created_at FROM oracle_artifacts ${filter} ORDER BY created_at DESC LIMIT 1`,values);
  return result.rows[0]||null;
}


export async function saveBetaRequest({email,name="",useCase=""}) {
  if (!enabled) throw new Error("Beta request storage is unavailable.");
  const result=await pool.query("INSERT INTO oracle_beta_requests (email,name,use_case) VALUES ($1,$2,$3) RETURNING id,status,created_at",[email,name,useCase]);
  return result.rows[0];
}

export async function listBetaRequests(limit=50) {
  if (!enabled) return [];
  const n=Math.max(1,Math.min(200,Number(limit)||50));
  const result=await pool.query("SELECT id,email,name,use_case,status,api_key_id,quota,approved_at,created_at FROM oracle_beta_requests ORDER BY created_at DESC LIMIT $1",[n]);
  return result.rows;
}


export async function approveBetaRequest({id,apiKeyId,apiKeyHash,quota}) {
  if(!enabled) throw new Error("Beta storage unavailable.");
  const result=await pool.query("UPDATE oracle_beta_requests SET status='approved',api_key_id=$2,api_key_hash=$3,quota=$4,approved_at=NOW() WHERE id=$1 AND status='pending' RETURNING id,email,name,use_case,status,api_key_id,quota,approved_at",[id,apiKeyId,apiKeyHash,quota]);
  return result.rows[0]||null;
}

export async function findActiveBetaKeyHashes() {
  if(!enabled) return [];
  const result=await pool.query("SELECT api_key_id,api_key_hash,quota FROM oracle_beta_requests WHERE status='approved' AND api_key_hash IS NOT NULL");
  return result.rows;
}


export async function revokeBetaRequest(id) {
  if(!enabled) throw new Error("Beta storage unavailable.");
  const result=await pool.query("UPDATE oracle_beta_requests SET status='revoked' WHERE id=$1 AND status='approved' RETURNING id,email,status,api_key_id,quota",[id]);
  return result.rows[0]||null;
}

export async function createSalesCampaign(campaign) {
  if (!enabled) throw new Error("Sales force storage requires DATABASE_URL.");
  const result=await pool.query(`
    INSERT INTO oracle_sales_campaigns
      (id,name,objective,offer,target_buyer,constraints_text,status,outreach_mode,authorized_auto_outreach,cadence_minutes,daily_run_limit,minimum_lead_score,max_leads_per_run,minimum_price,target_price,max_discount_percent,currency,next_run_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW()) RETURNING *
  `,[campaign.id,campaign.name,campaign.objective,campaign.offer,campaign.targetBuyer,campaign.constraints,campaign.status,campaign.outreachMode,campaign.authorizedAutoOutreach,campaign.cadenceMinutes,campaign.dailyRunLimit,campaign.minimumLeadScore,campaign.maxLeadsPerRun,campaign.minimumPrice,campaign.targetPrice,campaign.maxDiscountPercent,campaign.currency]);
  await recordSalesEvent({campaignId:campaign.id,eventType:"campaign_created",detail:{outreachMode:campaign.outreachMode}});
  return result.rows[0];
}

export async function listSalesCampaigns() {
  if (!enabled) return [];
  const result=await pool.query(`
    SELECT c.*,
      COUNT(l.id)::int AS lead_count,
      COUNT(l.id) FILTER (WHERE l.stage IN ('qualified','outreach_ready','contacted','replied','proposal'))::int AS active_leads,
      COUNT(l.id) FILTER (WHERE l.stage='won')::int AS won_count,
      COALESCE(SUM(l.actual_revenue) FILTER (WHERE l.stage='won'),0)::double precision AS won_revenue,
      COALESCE(SUM(l.actual_margin) FILTER (WHERE l.stage='won'),0)::double precision AS won_margin
    FROM oracle_sales_campaigns c LEFT JOIN oracle_sales_leads l ON l.campaign_id=c.id
    GROUP BY c.id ORDER BY c.created_at DESC
  `);
  return result.rows;
}

export async function getSalesCampaign(id) {
  if (!enabled) return null;
  const result=await pool.query("SELECT * FROM oracle_sales_campaigns WHERE id=$1",[id]);
  return result.rows[0]||null;
}

export async function updateSalesCampaignStatus(id,status) {
  if (!enabled) throw new Error("Sales force storage is unavailable.");
  const result=await pool.query("UPDATE oracle_sales_campaigns SET status=$2,next_run_at=CASE WHEN $2='running' THEN NOW() ELSE next_run_at END,updated_at=NOW() WHERE id=$1 RETURNING *",[id,status]);
  if(result.rows[0])await recordSalesEvent({campaignId:id,eventType:`campaign_${status}`,detail:{}});
  return result.rows[0]||null;
}

export async function listDueSalesCampaigns(limit=5) {
  if (!enabled) return [];
  const result=await pool.query(`
    UPDATE oracle_sales_campaigns SET runs_today=0,runs_date=CURRENT_DATE
    WHERE runs_date < CURRENT_DATE RETURNING id
  `);
  void result;
  const due=await pool.query(`SELECT * FROM oracle_sales_campaigns
    WHERE status='running' AND runs_today < daily_run_limit AND (next_run_at IS NULL OR next_run_at<=NOW())
    ORDER BY COALESCE(next_run_at,created_at) LIMIT $1`,[Math.max(1,Math.min(20,Number(limit)||5))]);
  return due.rows;
}

export async function markSalesCampaignRun(id,{ok,error=null}={}) {
  if (!enabled) return null;
  const result=await pool.query(`UPDATE oracle_sales_campaigns SET
    runs_today=runs_today+1,last_run_at=NOW(),next_run_at=NOW()+(cadence_minutes||' minutes')::interval,
    last_error=$2,updated_at=NOW() WHERE id=$1 RETURNING *`,[id,ok?null:String(error||"Unknown run error").slice(0,2000)]);
  return result.rows[0]||null;
}

export async function upsertSalesLead(lead) {
  if (!enabled) throw new Error("Sales force storage is unavailable.");
  const result=await pool.query(`
    INSERT INTO oracle_sales_leads
      (id,campaign_id,name,source,source_url,buyer_problem,buyer_email,evidence,score,stage,outreach_draft,estimated_value,estimated_margin)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)
    ON CONFLICT (campaign_id,source_url) DO UPDATE SET
      name=EXCLUDED.name,buyer_problem=EXCLUDED.buyer_problem,buyer_email=COALESCE(EXCLUDED.buyer_email,oracle_sales_leads.buyer_email),evidence=EXCLUDED.evidence,
      score=GREATEST(oracle_sales_leads.score,EXCLUDED.score),
      stage=CASE
        WHEN oracle_sales_leads.stage='lost'
          AND oracle_sales_leads.outreach_status='not_sent'
          AND COALESCE(oracle_sales_leads.notes,'') LIKE '%Closed automatically:%'
        THEN EXCLUDED.stage
        ELSE oracle_sales_leads.stage
      END,
      outreach_draft=CASE WHEN oracle_sales_leads.outreach_status='not_sent' THEN EXCLUDED.outreach_draft ELSE oracle_sales_leads.outreach_draft END,
      updated_at=NOW()
    RETURNING *
  `,[lead.id,lead.campaignId,lead.name,lead.source,lead.sourceUrl,lead.buyerProblem,lead.buyerEmail||null,safeJson(lead.evidence),lead.score,lead.stage,lead.outreachDraft,lead.estimatedValue,lead.estimatedMargin]);
  return result.rows[0];
}

export async function listSalesLeads({campaignId=null,limit=200}={}) {
  if (!enabled) return [];
  const n=Math.max(1,Math.min(500,Number(limit)||200));
  const result=campaignId
    ? await pool.query("SELECT * FROM oracle_sales_leads WHERE campaign_id=$1 ORDER BY score DESC,created_at DESC LIMIT $2",[campaignId,n])
    : await pool.query(`SELECT * FROM oracle_sales_leads
        ORDER BY
          CASE stage
            WHEN 'contacted' THEN 1
            WHEN 'replied' THEN 2
            WHEN 'proposal' THEN 3
            WHEN 'outreach_ready' THEN 4
            WHEN 'qualified' THEN 5
            WHEN 'discovered' THEN 6
            WHEN 'won' THEN 7
            WHEN 'lost' THEN 8
            ELSE 9
          END,
          score DESC,
          updated_at DESC
        LIMIT $1`,[n]);
  return result.rows;
}

export async function getSalesLead(id) {
  if (!enabled) return null;
  const result=await pool.query("SELECT * FROM oracle_sales_leads WHERE id=$1",[id]);
  return result.rows[0]||null;
}

export async function updateSalesLead(id,patch={}) {
  if (!enabled) throw new Error("Sales force storage is unavailable.");
  const result=await pool.query(`UPDATE oracle_sales_leads SET
    stage=COALESCE($2,stage),outreach_status=COALESCE($3,outreach_status),external_message_id=COALESCE($4,external_message_id),
    estimated_value=COALESCE($5,estimated_value),estimated_margin=COALESCE($6,estimated_margin),
    actual_revenue=COALESCE($7,actual_revenue),actual_margin=COALESCE($8,actual_margin),notes=COALESCE($9,notes),updated_at=NOW()
    WHERE id=$1 RETURNING *`,[id,patch.stage||null,patch.outreachStatus||null,patch.externalMessageId||null,patch.estimatedValue??null,patch.estimatedMargin??null,patch.actualRevenue??null,patch.actualMargin??null,patch.notes??null]);
  return result.rows[0]||null;
}

export async function ingestSalesReply({ classification, reply = {} }) {
  if (!enabled) throw new Error("Sales force storage is unavailable.");
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed=await client.query(`
      INSERT INTO oracle_sales_inbound_messages
        (provider_message_id,in_reply_to,classification,action,payload)
      VALUES ($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT (provider_message_id) DO NOTHING
      RETURNING provider_message_id
    `,[classification.providerMessageId,classification.inReplyTo,classification.classification,classification.action,safeJson(reply)]);
    if(!claimed.rowCount){await client.query("ROLLBACK");return {accepted:true,duplicate:true,action:"ignore"};}

    const matched=await client.query(`
      SELECT l.*,c.offer,c.minimum_price,c.target_price,c.max_discount_percent,c.currency
      FROM oracle_sales_leads l JOIN oracle_sales_campaigns c ON c.id=l.campaign_id
      WHERE l.external_message_id=$1 FOR UPDATE OF l
    `,[classification.inReplyTo]);
    let reason=null;
    if(matched.rowCount!==1) reason=matched.rowCount?"ambiguous_outbound_message":"unknown_outbound_message";
    else if(!["contacted","replied"].includes(matched.rows[0].stage)) reason="lead_not_awaiting_reply";
    if(reason){
      await client.query("UPDATE oracle_sales_inbound_messages SET status='held',processed_at=NOW() WHERE provider_message_id=$1",[classification.providerMessageId]);
      await client.query("INSERT INTO oracle_sales_events (event_type,detail) VALUES ('reply_unmatched',$1::jsonb)",[safeJson({providerMessageId:classification.providerMessageId,inReplyTo:classification.inReplyTo,reason})]);
      await client.query("COMMIT");
      return {accepted:false,action:"hold",reason};
    }

    const lead=matched.rows[0];
    const plan=planInboundReply({classification,campaign:lead,reply});
    const suppressNote=classification.action==="suppress"?`${lead.notes||""}\nInbound opt-out received; suppress future outreach.`.trim().slice(0,4000):lead.notes;
    const proposal=plan.proposal?.allowed?plan.proposal:null;
    const updated=await client.query(`UPDATE oracle_sales_leads SET
      stage=$2,notes=$3,proposal_draft=COALESCE($4,proposal_draft),proposal_price=COALESCE($5,proposal_price),
      proposal_currency=COALESCE($6,proposal_currency),proposal_status=$7,updated_at=NOW()
      WHERE id=$1 RETURNING *
    `,[lead.id,plan.stage,suppressNote,proposal?.reply||null,proposal?.price??null,proposal?.currency||null,plan.proposalStatus]);
    const replyDetail={providerMessageId:classification.providerMessageId,inReplyTo:classification.inReplyTo,action:classification.action,proposalStatus:plan.proposalStatus};
    await client.query("INSERT INTO oracle_sales_events (campaign_id,lead_id,event_type,detail) VALUES ($1,$2,$3,$4::jsonb)",[lead.campaign_id,lead.id,`reply_${classification.classification}`,safeJson(replyDetail)]);
    if(plan.proposalStatus!=="none"){
      await client.query("INSERT INTO oracle_sales_events (campaign_id,lead_id,event_type,detail) VALUES ($1,$2,$3,$4::jsonb)",[lead.campaign_id,lead.id,`proposal_${plan.proposalStatus}`,safeJson({providerMessageId:classification.providerMessageId,price:proposal?.price??null,currency:proposal?.currency||lead.currency||null,reason:plan.proposal?.reason||null,boundary:plan.proposal?.boundary||null,autoSend:false})]);
    }
    await client.query("UPDATE oracle_sales_inbound_messages SET campaign_id=$2,lead_id=$3,status='processed',processed_at=NOW() WHERE provider_message_id=$1",[classification.providerMessageId,lead.campaign_id,lead.id]);
    await client.query("COMMIT");
    return {accepted:true,classification:classification.classification,action:classification.action,leadId:lead.id,stage:updated.rows[0].stage,proposalStatus:plan.proposalStatus,proposal:proposal?{price:proposal.price,currency:proposal.currency,autoSend:false}:null};
  } catch(error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {client.release();}
}

export async function recordSalesEvent({campaignId=null,leadId=null,eventType,detail={}}) {
  if (!enabled) return null;
  const result=await pool.query("INSERT INTO oracle_sales_events (campaign_id,lead_id,event_type,detail) VALUES ($1,$2,$3,$4::jsonb) RETURNING *",[campaignId,leadId,eventType,safeJson(detail)]);
  return result.rows[0];
}

export async function listSalesEvents(campaignId=null,limit=100) {
  if (!enabled) return [];
  const n=Math.max(1,Math.min(500,Number(limit)||100));
  const result=campaignId
    ? await pool.query("SELECT * FROM oracle_sales_events WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT $2",[campaignId,n])
    : await pool.query("SELECT * FROM oracle_sales_events ORDER BY created_at DESC LIMIT $1",[n]);
  return result.rows;
}
