# Oracle Stack

Oracle Stack turns a normal request into a stronger, structured AI instruction without forcing the user to learn prompt engineering.

## V1 flow

1. **Oracle** reads the request and identifies intent, complexity, constraints, and the best specialist.
2. A **specialist agent** dynamically builds the upgraded Stack.
3. **Judge / QA** checks that the upgrade preserves intent, adds useful structure, avoids invented requirements, and is ready to use.
4. If Judge finds a problem, the specialist gets one automatic repair pass.
5. The UI shows **Original vs Upgraded** with one-click copy.

Initial specialist domains:

- Business
- Research
- Writing
- Coding
- Career
- General fallback

## Local setup

```bash
npm install
cp .env.example .env
# add your OPENAI_API_KEY
npm start
```

Open `http://localhost:3000`.

## Environment variables

- `OPENAI_API_KEY` — required
- `ORACLE_MODEL` — optional, defaults to `gpt-5.6`
- `AGENT_MODEL` — optional, defaults to `gpt-5.6`
- `JUDGE_MODEL` — optional, defaults to `gpt-5.6`
- `PORT` — optional, defaults to `3000`

## API

### Health

`GET /api/health`

### Upgrade a request

`POST /api/oracle`

```json
{
  "request": "Build me a landing page for a dog grooming business"
}
```

## V1 boundary

Oracle Stack is a standalone product. Accounts, saved Stacks, Stack performance data, marketplace features, billing, and external one-click sending can come after the core routing + upgrade loop proves useful.
