import {
  CATEGORIES,
  COUNTRIES,
  type CellChange,
  type Chart,
  type Snapshot,
  chartForMonth,
  diffCells,
  monthLabelEn,
  monthLabelZh,
} from "./snapshot";

export const EVENT_TYPES = ["bulletin.published", "bulletin.updated", "uscis.chart_decided"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface StoredBulletin {
  snapshot: Snapshot;
  uscis_chart: Chart | null;
}

export interface Decision {
  events: EventType[];
  /** Snapshot to store: the incoming one, keeping a known USCIS chart if the publisher sent none. */
  merged: Snapshot;
  changes: CellChange[];
}

/**
 * Decide which events an ingested snapshot produces, compared with what is stored.
 * - month never seen and newer than every stored month -> bulletin.published
 * - month never seen but older than the latest stored month (backfill) -> nothing
 * - same month, any of the 12 cells differs -> bulletin.updated
 * - USCIS chart for this month first seen or changed -> uscis.chart_decided
 */
export function decideEvents(stored: StoredBulletin | null, latestMonth: string | null, incoming: Snapshot): Decision {
  let merged = incoming;
  if (chartForMonth(incoming) === null && stored?.uscis_chart) {
    merged = { ...incoming, uscis: stored.snapshot.uscis };
  }
  const chart = chartForMonth(merged);
  const events: EventType[] = [];

  if (!stored) {
    const isNewest = latestMonth === null || incoming.bulletin > latestMonth;
    if (isNewest) {
      events.push("bulletin.published");
      if (chart) events.push("uscis.chart_decided");
    }
    return { events, merged, changes: [] };
  }

  const changes = diffCells(stored.snapshot.dates, merged.dates);
  if (changes.length) events.push("bulletin.updated");
  if (chart && chart !== stored.uscis_chart) events.push("uscis.chart_decided");
  return { events, merged, changes };
}

const CHART_NAME_EN: Record<Chart, string> = { A: "Final Action Dates", B: "Dates for Filing" };
const CHART_NAME_ZH: Record<Chart, string> = { A: "表A 最终行动日期", B: "表B 递交申请日期" };

function cellsSummary(s: Snapshot): string {
  return COUNTRIES.map((c) =>
    CATEGORIES.map((cat) => `${c} ${cat} A ${s.dates[c][cat].A} / B ${s.dates[c][cat].B}`).join(", "),
  ).join("; ");
}

/** One-line human summary, English then Chinese. */
export function formatMessage(type: EventType | "ping", s: Snapshot | null, changes: CellChange[] = []): string {
  if (type === "ping") {
    return "visa-bulletin-push test delivery: your webhook is reachable | 测试推送：你的 webhook 可以正常接收";
  }
  if (!s) throw new Error("snapshot required");
  const en = monthLabelEn(s.bulletin);
  const zh = monthLabelZh(s.bulletin);
  const chart = chartForMonth(s);

  if (type === "bulletin.published") {
    const uscisEn = chart ? `USCIS: use chart ${chart}` : "USCIS: chart not announced yet";
    const uscisZh = chart ? `USCIS：职业移民 I-485 用${CHART_NAME_ZH[chart]}` : "USCIS 尚未公布用哪张表";
    return `${en} Visa Bulletin: ${cellsSummary(s)}. ${uscisEn} | ${zh}签证排期已发布（A=最终行动日期，B=递交申请日期），${uscisZh}`;
  }
  if (type === "bulletin.updated") {
    const list = changes.map((c) => `${c.country} ${c.category} ${c.chart} ${c.from} → ${c.to}`).join(", ");
    return `${en} Visa Bulletin updated: ${list} | ${zh}签证排期有更正：${list}`;
  }
  // uscis.chart_decided
  const c = chart as Chart;
  return `${en}: USCIS: use chart ${c} (${CHART_NAME_EN[c]}) for employment-based I-485 | ${zh}：USCIS 职业移民 I-485 用${CHART_NAME_ZH[c]}`;
}
