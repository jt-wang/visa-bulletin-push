import { describe, expect, it } from "vitest";
import { parseBulletinFlat, parseBulletinHtml, parseBulletinPdf, pdfFlatText } from "../src/sources/bulletin";
import { parseUscisCharts } from "../src/sources/uscis";
import { octoberSnapshot } from "./helpers";
import { OCT_2026_HTML, USCIS_OCT_2026_HTML } from "./fixtures/pages";
import { OCT_2026_PDF_B64, SEP_2026_PDF_B64 } from "./fixtures/pdfs";

const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

describe("official bulletin PDF", () => {
  it("October 2026: all twelve China and India cells, both charts", async () => {
    const p = await parseBulletinPdf(bytes(OCT_2026_PDF_B64));
    expect(p.bulletin).toBe("2026-10");
    expect(p.dates).toEqual(octoberSnapshot().dates);
    expect(p.raw.CN.EB3).toEqual({ A: "08JAN22", B: "01APR24" });
  });

  it("September 2026: a second real bulletin, including an unavailable cell", async () => {
    const p = await parseBulletinPdf(bytes(SEP_2026_PDF_B64));
    expect(p.bulletin).toBe("2026-09");
    expect(p.dates.CN.EB3).toEqual({ A: "2022-01-01", B: "2022-01-08" });
    expect(p.dates.IN.EB2.A).toBe("U");
    expect(p.dates.IN.EB1).toEqual({ A: "2022-10-15", B: "2023-12-01" });
  });

  it("rejects bytes that are not a PDF", async () => {
    await expect(parseBulletinPdf(new TextEncoder().encode("<html>Just a moment...</html>"))).rejects.toThrow();
  });
});

describe("bulletin text rules", () => {
  async function octFlat(): Promise<string> {
    return pdfFlatText(bytes(OCT_2026_PDF_B64));
  }

  it("ignores a typo in a column we do not publish", async () => {
    // The official 2025-10 PDF printed Mexico EB2 Dates for Filing as "15UL24" (seen 2026-10-04).
    const flat = await octFlat();
    const row = "2nd15MAR2601JAN2315JAN1515MAR2615MAR26";
    expect(flat).toContain(row);
    const p = parseBulletinFlat(flat.replace(row, "2nd15MAR2601JAN2315JAN1515UL2415MAR26"));
    expect(p.dates).toEqual(octoberSnapshot().dates);
  });

  it("refuses a table whose country columns are in a different order", async () => {
    const flat = (await octFlat()).replaceAll("CHINA-mainlandbornINDIA", "INDIACHINA-mainlandborn");
    expect(() => parseBulletinFlat(flat)).toThrow(/column/);
  });

  it("refuses a malformed China or India cell", async () => {
    const flat = (await octFlat()).replace("2nd01JAN2501OCT21", "2nd01JAN2501OCX21");
    expect(() => parseBulletinFlat(flat)).toThrow();
  });
});

describe("official bulletin HTML", () => {
  it("gives the same twelve cells as the PDF", () => {
    const h = parseBulletinHtml(OCT_2026_HTML);
    expect(h.bulletin).toBe("2026-10");
    expect(h.dates).toEqual(octoberSnapshot().dates);
  });

  it("refuses a challenge page", () => {
    expect(() => parseBulletinHtml("<html><title>Just a moment...</title></html>")).toThrow();
  });
});

describe("USCIS filing charts page", () => {
  it("reads the employment-based chart for October 2026", () => {
    expect(parseUscisCharts(USCIS_OCT_2026_HTML)).toContainEqual({ bulletin: "2026-10", employment_chart: "B" });
  });

  it("returns nothing when the sentence is missing, and A for a Final Action sentence", () => {
    expect(parseUscisCharts("<p>Nothing here</p>")).toEqual([]);
    const a =
      "<p>For Employment-Based Preference Filings:</p><p>For all employment-based preference categories, you must use the Final Action Dates chart in the Department of State Visa Bulletin for November 2026.</p>";
    expect(parseUscisCharts(a)).toEqual([{ bulletin: "2026-11", employment_chart: "A" }]);
  });
});
