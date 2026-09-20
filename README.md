# Oracle Stack

Oracle Stack is an autonomous sales-force and opportunity-execution system. It finds current buyer demand, qualifies opportunities, prepares or sends authorized outreach, tracks deals and revenue, and learns which workflows convert. Its adaptive model router is the internal brain that selects specialists/models, checks work, repairs failures and learns from outcomes.

## Autonomous sales force

Open `/sales.html` with `ORACLE_ADMIN_TOKEN` to launch and manage persistent campaigns.

Each campaign has a mission, optional offer and target buyer, lead threshold, run cadence, daily-run cap and outreach mode. The background loop:

1. Searches configured live-discovery sources for current demand.
2. Rejects weak/closed signals and scores evidence.
3. Stores qualified leads and tailored outreach drafts.
4. Sends outreach only when the campaign explicitly authorizes auto-outreach and `SALES_OUTREACH_WEBHOOK_URL` is configured.
5. Tracks contacted, replied, proposal, won and lost stages plus actual revenue and margin.

Campaigns can be paused globally with `SALES_FORCE_ENABLED=false` or individually from the dashboard. Payments, purchases and contracts are never executed by the campaign loop.

## V2 flow

1. **Oracle Router** identifies intent, domain, complexity, and minimum execution depth.
2. **Adaptive Model Router** ranks configured execution models using domain fit, quality, speed, cost, and learned performance.
3. A **specialist agent** executes the request using the highest-ranked model.
4. **Judge / QA** checks the result for material failures.
5. If QA fails, the specialist gets one repair pass and Oracle judges the repaired answer again.
6. If the provider/model errors, times out, or still fails QA, Oracle automatically tries the next-ranked configured model.
7. Oracle records route performance, latency, tokens, repairs, failovers, success/failure, and user feedback for future routing.

Specialist domains: Business, Research, Writing, Coding, Career, and General fallback.

## OpenAI three-tier execution pool

With one `OPENAI_API_KEY`, Oracle can expose three independently ranked OpenAI execution routes: Sol, Terra, and Luna. The router and final QA can remain on Sol while specialist execution competes across the three tiers.

The defaults are `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. Each route has separate quality, speed, and cost priors, and learned performance is tracked separately by model/domain/depth. Set any `OPENAI_*_ENABLED=false` to remove that tier without changing code.

For backward compatibility, an existing `AGENT_MODEL` remains a single-model pool when none of the three tier-specific model variables are configured. New deployments should use the tier variables.

## Providers and failover

OpenAI remains the default and is used for Oracle routing and final QA. Specialist execution can also be routed to Anthropic and Gemini when those providers are configured.

Automatic requests can fail over across ranked execution models, including models from the same provider. Configure:

```text
PROVIDER_TIMEOUT_MS=45000
MAX_FAILOVER_MODELS=3
```

`MAX_FAILOVER_MODELS` is capped at five. Explicit model requests used for benchmarking do not fail over, so benchmarks remain model-specific.

The response telemetry includes `failoverCount` and `attemptedModels`, and `/api/metrics` exposes aggregate failovers and provider failures.

## Routing policies

Set `ROUTING_POLICY` to `quality`, `balanced`, or `cost`. Model priors in `.env.example` are starting assumptions; learned performance increasingly influences selection as Oracle accumulates outcomes.

## Persistent learning

Oracle supports optional Postgres persistence through `DATABASE_URL`.

When Postgres is configured Oracle automatically creates and uses:

- `oracle_route_performance` — durable learned performance by model/domain/depth
- `oracle_executions` — execution history including API key attribution, provider, model, route, QA outcome, latency, tokens, repairs, and user feedback

At startup Oracle hydrates its in-memory routing cache from Postgres. If `DATABASE_URL` is absent or initialization fails, Oracle continues in memory.

## Developer API

The browser UI uses `POST /api/oracle`. External applications should use `POST /v1/oracle`.

Send the key as `Authorization: Bearer <secret>` or `X-Oracle-Key: <secret>`.

Configure keys with `ORACLE_API_KEYS` using comma-separated `id:secret` pairs. Only the key ID is written to telemetry; secrets are hashed in memory and are not logged.

### Quotas and usage

`GET /v1/usage` returns the calling key's quota state plus current-process usage and, with Postgres, its durable 30-day usage summary.

`ORACLE_API_DEFAULT_QUOTA` sets the default monthly execution quota. `ORACLE_API_QUOTAS` provides per-key overrides, such as `owner=5000,starter=100`.

When pricing is known, authenticated responses also include an estimated API cost. Unknown/custom models stay unpriced unless explicit per-provider price overrides are supplied in environment variables.

## Local setup

```bash
npm install
cp .env.example .env
# add OPENAI_API_KEY and optionally provider keys/models, DATABASE_URL, and ORACLE_API_KEYS
npm start
```

Open `http://localhost:3000`.

## Benchmarking

Run the repeatable benchmark suite against a running Oracle instance:

```bash
npm run benchmark
```

Set `ORACLE_BENCHMARK_URL` to benchmark a deployed instance instead of localhost. With the three OpenAI tiers enabled, the benchmark runner can compare Oracle auto-routing against explicit Sol, Terra, and Luna runs while explicit runs remain failover-free.

## API

`GET /api/health` — routing, persistence, developer API and failover status.

`GET /api/models` — configured execution models and routing priors.

`POST /api/oracle` — browser/product execution.

`POST /v1/oracle` — authenticated developer execution.

`POST /api/feedback` — submit a 1–5 outcome score using the returned `executionId`.

`GET /api/metrics` — system routing, learning, failure and failover metrics.

`GET /v1/usage` — authenticated usage/quota information for the calling API key.

## Product direction

Oracle Stack is not another model picker or prompt enhancer. The product is the automatic sales force: Oracle is the brain, and Opportunity Finder, qualification, Buyer Matcher, outreach and Deal Orchestrator are the workforce. Model routing remains supporting infrastructure.

Next milestones: connect approved outreach channels, ingest reply events, automate proposal drafting/handoffs, and train campaign prioritization on real conversion, revenue and margin outcomes.
