export const dealOrchestrator = {
  id: "deal-orchestrator",
  description: "Coordinates opportunity discovery, validation, buyer matching, outreach, handoff and outcome learning.",
  stages: [
    "discover_opportunity",
    "validate_demand",
    "validate_supply",
    "calculate_unit_economics",
    "match_buyers",
    "prepare_outreach",
    "track_response",
    "record_outcome"
  ],
  guardrails: {
    requireEvidenceBeforeOutreach: true,
    noInventedBuyers: true,
    noInventedSuppliers: true,
    noSpamOrDeception: true,
    requireHumanApprovalForPaymentsContractsAndAccountActions: true
  }
};
