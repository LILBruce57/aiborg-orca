// CJS mirror of the test seam in src/main/aiborg/upstream-service-policy.ts, for build scripts
// outside the TS build. Only Vitest plus config/aiborg/vitest-upstream-behavior-setup.ts sets both.
function isUpstreamBehaviorUnderTest(env = process.env) {
  return env.VITEST === 'true' && env.AIBORG_UPSTREAM_BEHAVIOR_IN_TESTS === '1'
}

function brandedOrUpstream(aiborgValue, upstreamValue) {
  return isUpstreamBehaviorUnderTest() ? upstreamValue : aiborgValue
}

module.exports = { isUpstreamBehaviorUnderTest, brandedOrUpstream }
