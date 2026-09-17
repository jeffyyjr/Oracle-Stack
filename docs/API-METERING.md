# Oracle API metering

Oracle's authenticated `/v1` API enforces a monthly execution quota per API key.

## Quotas

- `ORACLE_API_DEFAULT_QUOTA` sets the default monthly request limit per key.
- `ORACLE_API_QUOTAS` overrides individual keys with `keyId=limit,keyId2=limit`.
- Quota windows use UTC calendar months.
- Responses include `X-Oracle-Quota-Limit`, `X-Oracle-Quota-Used`, `X-Oracle-Quota-Remaining`, and `X-Oracle-Quota-Window` headers.
- A key that exceeds its limit receives HTTP 429.

Quota counters are currently process-local. Persistent quota counters should move into Postgres when a dedicated database is available.

## Cost estimates

Authenticated Oracle responses include an `estimatedCost` object in telemetry when pricing is known. Current built-in known-model pricing includes GPT-5.6 Sol and Claude Sonnet 5. Other models can be priced explicitly with:

- `ORACLE_OPENAI_INPUT_USD_PER_M`
- `ORACLE_OPENAI_OUTPUT_USD_PER_M`
- `ORACLE_ANTHROPIC_INPUT_USD_PER_M`
- `ORACLE_ANTHROPIC_OUTPUT_USD_PER_M`
- `ORACLE_GEMINI_INPUT_USD_PER_M`
- `ORACLE_GEMINI_OUTPUT_USD_PER_M`

Values are USD per one million tokens. Unknown model prices return `estimatedCost: null` rather than guessing.
