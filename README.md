# Oracle Stack

Oracle Stack is an adaptive AI execution layer. A user or application sends Oracle one request; Oracle determines the task type and depth, selects a specialist and execution model, runs the task, QA-checks the answer, repairs material failures, and records performance signals for future routing.

## V2 flow

1. **Oracle Router** identifies intent, domain, complexity, and minimum execution depth.
2. **Adaptive Model Router** scores configured execution models using domain fit, quality, speed, cost, and learned performance.
3. A **specialist agent** executes the request using the selected provider/model.
4. **Judge / QA** checks the answer for material failures.
5. If QA fails, the specialist gets one automatic repair pass.
6. Oracle records latency, token usage, model selection, repairs, success/failure, and user feedback.
7. Future requests use those results as part of their routing score.

Specialist domains: Business, Research, Writing, Coding, Career, and General fallback.

## Providers

OpenAI remains the default and is used for Oracle routing and final QA. Execution can be routed to OpenAI, Anthropic, and Gemini when those providers are configured.

## Routing policies

Set `ROUTING_POLICY` to `quality`, `balanced`, or `cost`. Provider priors in `.env.example` are starting assumptions; learned route performance increasingly influences selection as Oracle accumulates outcomes.

## Persistent learning

Oracle now supports optional Postgres persistence through `DATABASE_URL`.

When Postgres is configured Oracle automatically creates and uses:

- `oracle_route_performance` — durable learned performance by model/domain/depth
- `oracle_executions` — execution history including provider, model, route, QA outcome, latency, tokens, repairs, and user feedback

At startup Oracle hydrates its in-memory routing cache from Postgres. That keeps routing fast while allowing learned behavior to survive deploys and restarts. If `DATABASE_URL` is absent or storage initialization fails, Oracle continues in memory rather than preventing the service from starting.

## Local setup

```bash
npm install
cp .env.example .env
# add OPENAI_API_KEY and optionally provider keys/models + DATABASE_URL
npm start
```

Open `http://localhost:3000`.

## Benchmarking

Run the repeatable benchmark suite against a running Oracle instance:

```bash
npm run benchmark
```

Set `ORACLE_BENCHMARK_URL` to benchmark a deployed instance instead of localhost.

## API

### Health

`GET /api/health`

Returns routing mode, policy, persistence mode, configured providers, and models.

### Available models

`GET /api/models`

Returns configured execution models and routing priors.

### Execute a request

`POST /api/oracle`

```json
{
  "request": "Build me a landing page for a dog grooming business"
}
```

Oracle chooses the execution model automatically. For benchmark/testing purposes a caller can explicitly request a configured model by registry ID or model name.

The response includes the answer, route, QA result, selected model, and telemetry. Telemetry includes an `executionId` used for feedback.

### Submit outcome feedback

`POST /api/feedback`

```json
{
  "executionId": "<execution id from /api/oracle>",
  "score": 5
}
```

Scores are 1–5. With Postgres enabled feedback still works after a service restart because Oracle can recover the execution record from durable storage.

### Metrics and usage

`GET /api/metrics`

Returns current-process metrics, learned route statistics, persistence mode, and a 30-day durable execution summary when Postgres is enabled.

## Product direction

Oracle Stack is not intended to be another model picker or prompt enhancer. The target is a single execution API that chooses the model, specialist, and reasoning depth that best fit a task, checks the result, learns from outcomes, and improves routing over time.

Next infrastructure milestones: API authentication and per-key usage limits, real provider cost accounting, production fallback/retry routing, and benchmark-driven tuning of routing weights.
