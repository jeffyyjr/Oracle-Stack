# Oracle Revenue Loop

Oracle Stack is evolving from a model-routing layer into an autonomous opportunity-and-execution system.

## First revenue workflow

1. Opportunity Finder searches for legitimate products, services, digital goods, leads, or arbitrage-style opportunities.
2. Validation checks demand, supply, unit economics, competition, platform constraints, and evidence quality.
3. Buyer Matcher defines who is likely to buy and where genuine buying intent can be found.
4. Deal Orchestrator coordinates the handoff and records outcomes.
5. Revenue telemetry feeds results back into Oracle so future routing can learn which opportunity types and workflows actually convert.

## Non-negotiable design rules

- Never fabricate a supplier, buyer, price, demand signal, sale, or revenue.
- Discovery and matching may be autonomous; payments, contracts, and consequential account actions require explicit authorization.
- No spam, impersonation, deceptive listings, fake scarcity, or platform-rule evasion.
- Optimize for completed profitable transactions, not agent activity.
- Track failures too. A workflow that generates lots of leads but no sales should lose priority.

## Implemented control loop

- Persistent scheduled campaigns with pause/resume, cadence and daily-run caps.
- Structured leads, evidence, stages, outreach drafts, events, revenue and margin.
- Demand-first discovery and lead scoring.
- Owner command center at `/sales.html`.
- Optional signed outreach webhook, used only after campaign-level authorization.
- Authenticated inbound reply correlation with global provider-message deduplication.
- Transactional reply processing: classification, proposal persistence and pipeline movement either commit together or roll back together.
- Campaign-level minimum/target prices and discount limits; below-floor offers escalate and proposals remain unsent drafts.

## Next build

Connect an approved outreach provider and add an owner approval/send handoff for saved proposal drafts. Then use real conversion and margin outcomes—not activity volume—to reprioritize campaign types.
