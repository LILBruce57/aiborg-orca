// Upstream suites assert upstream behaviour; AI-Borg suites clear this flag to test the fork.
// Read by src/main/aiborg/upstream-service-policy.ts and config/aiborg/upstream-behavior-seam.cjs.
process.env.AIBORG_UPSTREAM_BEHAVIOR_IN_TESTS = '1'
