// USCIS "Adjustment of Status Filing Charts from the Visa Bulletin" page: which
// chart (A = Final Action Dates, B = Dates for Filing) USCIS accepts for
// employment-based I-485 each month. Measured 2026-10-04: the page states it in
// one sentence per month; uscis.gov answers Cloudflare egress with 200.

import type { Chart } from "../snapshot";
import { htmlText } from "./bulletin";

export const USCIS_CHARTS_URL =
  "https://www.uscis.gov/green-card/green-card-processes-and-procedures/visa-availability-priority-dates/adjustment-of-status-filing-charts-from-the-visa-bulletin";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const SENTENCE =
  /For all employment-based preference categories,? you must use the (Final Action Dates|Dates for Filing) chart in the Department of State Visa Bulletin for ([A-Za-z]+) (\d{4})/gi;

export interface UscisChart {
  bulletin: string; // YYYY-MM
  employment_chart: Chart;
}

/** Every employment-based sentence on the page, in page order. */
export function parseUscisCharts(page: string): UscisChart[] {
  const text = htmlText(page.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " "));
  const out: UscisChart[] = [];
  for (const m of text.matchAll(SENTENCE)) {
    const i = MONTHS.indexOf(m[2]!.toLowerCase());
    if (i < 0) continue;
    const bulletin = `${m[3]}-${String(i + 1).padStart(2, "0")}`;
    if (out.some((e) => e.bulletin === bulletin)) continue;
    out.push({ bulletin, employment_chart: m[1]!.toLowerCase().startsWith("final") ? "A" : "B" });
  }
  return out;
}
