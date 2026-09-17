# Oracle Stack

Oracle Stack is an adaptive AI execution layer. A user or application sends Oracle one request; Oracle determines the task type and depth, selects a specialist and execution model, runs the task, QA-checks the answer, repairs material failures, and records performance signals for future routing.

## V2 flow

1. **Oracle Router** identifies intent, domain, complexity, and minimum execution depth.
2. **Adaptive Model Router** scores the configured execution models using:
   - domain fit
   - quality prior
   - speed prior
   - cost prior
   - observed Oracle performance for that domain/depth
3. A **specialist agent** executes the request using the selected provider/model.
4. **Judge / QA** checks the answer for material failures.
5. If QA fails, the same specialist gets one automatic repair pass.
6. Oracle records latency, token usage, model selection, repairs, success/failure, and user feedback.
7. Future requests use those results as part of their routing score.

Specialist domains:

- Business
- Research
- Writing
- Coding
- Career
- General fallback

## Providers

OpenAI remains the default and is used for Oracle routing and final QA. Execution can currently be routed to:

- OpenAI
- Anthropic (optional)
- Gemini (optional)

Optional providers are enabled only when both their API key and model name are configured. This keeps the existing OpenAI-only deployment working without changes.

## Routing policies

Set `ROUTING_POLICY` to one of:

- `quality` — favor output quality and learned success
- `balanced` — balance quality, speed, cost, and learned success (default)
- `cost` — put more weight on cheaper execution while still considering quality and learned success

The numeric provider priors in `.env.example` are starting assumptions only. Oracle's observed performance score increasingly influences selection as executions and user feedback accumulate.

> V2 learning state is currently held in memory. It resets when the server restarts. Persistent performance history should move to Postgres/Redis after the routing behavior is validated.

## Local setup

```bash
npm install
cp .env.example .env
# add OPENAI_API_KEY and optionally additional provider keys/models
npm start
```

Open `http://localhost:3000`.

## API

### Health

`GET /api/health`

Returns the routing mode, policy, configured providers, and available models.

### Available models

`GET /api/models`

Returns the configured execution models and their routing priors.

### Execute a request

`POST /api/oracle`

```json
{
  "request": "Build me a landing page for a dog grooming business"
}
```

Oracle automatically chooses the execution model. For testing, a caller can explicitly request a configured model by its registry ID or model name:

```json
{
  "request": "Refactor this JavaScript function",
  "model": "openai:gpt-5.6"
}
```

The response includes the finished answer plus route, QA, selected-model, and telemetry information. Telemetry includes an `executionId` that can be used for feedback.

### Submit outcome feedback

`POST /api/feedback`

```json
{
  "executionId": "<execution id from /api/oracle>",
  "score": 5
}
```

Scores are 1–5 and feed the adaptive routing score for that model/domain/depth combination.

### Metrics and learning state

`GET /api/metrics`

Returns aggregate request/token/latency metrics plus learned route statistics.

## Product direction

Oracle Stack is not intended to be another model picker or prompt enhancer. The target product is a single execution API that chooses the model, specialist, and reasoning depth that best fit a task, checks the result, learns from outcomes, and improves routing over time.

The next infrastructure milestones are persistent performance storage, API authentication/usage limits, true cost accounting, benchmarking across providers, and production-grade fallback/retry routing.
