# Oracle Stack — Working State

Purpose: durable handoff between build sessions. Read this before substantial Oracle work and update it after major milestones.

## Current phase
Self-serve developer beta validation. Favor evidence from real users and deployment behavior over adding speculative features.

## Resume procedure
1. Read this file and README.md.
2. Check current Git HEAD and the matching Render deployment.
3. Verify the service with zero-cost checks first.
4. Make the smallest change justified by observed evidence.
5. Verify the replacement deployment.
6. Update this file when state materially changes.

## Cost / safety guardrails
- Routine deployment verification must not invoke paid AI models.
- Do not run benchmarks unless Jeff explicitly requests them.
- Prefer page-load, health, authentication/authorization, deployment-state, and startup-log checks.
- Never commit API keys, passwords, tokens, cookies, or other secret values.
- Environment-variable names may be documented; secret values may not.

## Architecture snapshot
Oracle is an adaptive AI execution layer: route task -> choose specialist/model -> execute -> QA -> repair/fail over when needed -> learn from outcomes.

Documented specialist domains: Business, Research, Writing, Coding, Career, General.

Key documented surfaces:
- POST /v1/oracle — authenticated developer execution
- GET /v1/usage — authenticated usage/quota information
- POST /api/oracle — browser/product execution
- GET /api/health — service/routing/persistence status
- GET /api/models — configured execution models
- GET /api/metrics — routing/learning/failure metrics
- POST /api/feedback — outcome feedback

Persistence can use Postgres through DATABASE_URL. Developer credentials are configured through ORACLE_API_KEYS. Never put their values here.

## Deployment verification
For a new Render build, verify without paid inference:
- deployment becomes live/healthy;
- startup logs have no material startup errors;
- developer beta page loads;
- protected/internal endpoints reject unauthorized requests as intended;
- no benchmark or paid Oracle execution is triggered.

A successful build alone is not proof that the live service is correct.

## Current priorities
- Validate self-serve beta with real users.
- Harden authentication, quotas, usage accounting, and customer-facing developer flow based on observed behavior.
- Keep routing-learning work evidence-driven.
- Avoid feature sprawl until beta usage identifies the next bottleneck.

## Handoff rule
Before ending a major build/debugging phase, replace stale details here with:
- deployed commit/build;
- what changed;
- what was verified;
- unresolved blocker(s);
- exact next action.

Do not turn this into a transcript. Keep it compact enough to reload cheaply.

_Last initialized: 2026-09-19._
