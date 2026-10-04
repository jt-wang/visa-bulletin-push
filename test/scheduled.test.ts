import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("scheduled entry points", () => {
  it("exports a scheduled handler for the Cron Trigger", () => {
    expect(typeof (worker as any).scheduled).toBe("function");
  });

  it("refuses an unsigned manual poll", async () => {
    const res = await exports.default.fetch("https://vb.example/v1/admin/poll", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("only accepts POST for the manual poll", async () => {
    const res = await exports.default.fetch("https://vb.example/v1/admin/poll");
    expect(res.status).toBe(405);
  });
});
