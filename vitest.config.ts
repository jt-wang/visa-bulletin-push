import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // The workerd bundled with the test pool cannot run a compatibility date newer than
          // its own build (ERR_FUTURE_COMPATIBILITY_DATE). Production uses wrangler.jsonc's date.
          compatibilityDate: "2026-08-15",
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Test-only values. Real values are set with `wrangler secret put`.
            INGEST_SECRET: "test-ingest-secret",
            TOKEN_ENC_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
            IP_HASH_SALT: "test-salt",
            // Neutral author config; the real one lives only in the private deployment config.
            AUTHOR_NAME: "Ada",
            AUTHOR_X: "ada_example",
            AUTHOR_SITE: "https://example.com",
            AUTHOR_BIO_EN: "Test bio in English.",
            AUTHOR_BIO_ZH: "测试用的中文介绍。",
            PUBLIC_URL: "https://vb.example",
            SOURCE_URL: "https://github.com/example/visa-bulletin-push",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
