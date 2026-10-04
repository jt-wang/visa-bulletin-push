import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Storage is isolated per test file, not per test, so every test starts from empty tables.
beforeEach(async () => {
  await env.DB.batch(
    [
      "mcp_deliveries",
      "mcp_subscriptions",
      "mcp_verified_callbacks",
      "mcp_verification_attempts",
      "deliveries",
      "events",
      "subscriptions",
      "bulletins",
      "registration_limits",
      "poll_state",
      "test_sends",
      "cards",
    ].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
});
