import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeMove, renderHome } from "../src/site";
import { ingest, octoberSnapshot } from "./helpers";

const get = (path: string, init?: RequestInit) => exports.default.fetch(`https://vb.example${path}`, init);

/** September 2026 values, parsed from the official PDF. */
function septemberSnapshot(): any {
  const s = octoberSnapshot();
  s.bulletin = "2026-09";
  s.dates = {
    CN: {
      EB1: { A: "2023-07-01", B: "2023-12-01" },
      EB2: { A: "2021-09-01", B: "2022-01-01" },
      EB3: { A: "2022-01-01", B: "2022-01-08" },
    },
    IN: {
      EB1: { A: "2022-10-15", B: "2023-12-01" },
      EB2: { A: "U", B: "2015-01-15" },
      EB3: { A: "2014-01-01", B: "2015-01-15" },
    },
  };
  s.uscis = null;
  s.source.pdf_url = "https://travel.state.gov/content/dam/visas/Bulletins/visabulletin_September2026.pdf";
  return s;
}

beforeEach(() => {
  vi.spyOn(env.DELIVERY_QUEUE, "sendBatch").mockResolvedValue(undefined as any);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("describeMove (pure)", () => {
  it("counts whole months and leftover days forward", () => {
    expect(describeMove("2022-01-08", "2024-04-01")).toEqual({ kind: "forward", months: 26, days: 24 });
    expect(describeMove("2022-10-15", "2023-02-01")).toEqual({ kind: "forward", months: 3, days: 17 });
    expect(describeMove("2022-01-01", "2022-01-08")).toEqual({ kind: "forward", months: 0, days: 7 });
  });

  it("reports retrogression, no change and availability changes", () => {
    expect(describeMove("2024-04-01", "2022-01-08")).toEqual({ kind: "back", months: 26, days: 24 });
    expect(describeMove("2023-07-01", "2023-07-01")).toEqual({ kind: "same", months: 0, days: 0 });
    expect(describeMove("U", "2013-11-01").kind).toBe("reopened");
    expect(describeMove("2013-11-01", "U").kind).toBe("unavailable");
    expect(describeMove("2020-01-01", "C").kind).toBe("current");
    expect(describeMove("C", "2020-01-01").kind).toBe("back");
    expect(describeMove(null, "2020-01-01").kind).toBe("unknown");
  });
});

describe("home page", () => {
  beforeEach(async () => {
    await ingest(septemberSnapshot());
    await ingest(octoberSnapshot());
  });

  it("is English by default and sells the checker, alerts, agents and the author", async () => {
    const res = await get("/");
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('<html lang="en"');
    expect(html).toContain("Can I file I-485 this month?");
    expect(html).toContain('id="checker"');
    // Author details come only from deployment config (test bindings in vitest.config.ts).
    expect(html).toContain("https://x.com/ada_example");
    expect(html).toContain("Follow @ada_example");
    expect(html).toContain("claude mcp add --transport http visa-bulletin https://vb.example/mcp");
    expect(html).toContain("https://vb.example/skill.md");
    expect(html).toContain("curl https://vb.example/v1/latest.json");
    expect(html).toContain("USCIS accepts chart B");
    expect(html).toContain("Unofficial. Not legal advice.");
    expect(html).not.toMatch(/<script[^>]+src=/); // no third-party scripts / trackers
  });

  it("has one primary call to action and an agent recipe for each supported agent", async () => {
    const html = await (await get("/")).text();
    const primaries = html.match(/class="btn btn-primary"/g) ?? [];
    expect(primaries).toHaveLength(1);
    expect(html).toContain("Add to your agent");
    for (const agent of ["ChatGPT", "Grok Bot", "Claude Code", "Any webhook"]) expect(html).toContain(`>${agent}</button>`);
  });

  it("walks each agent through setup without a terminal where the agent has no terminal", async () => {
    const html = await (await get("/")).text();
    // Grok and plain webhooks connect from a form on the page; no curl needed.
    expect(html).toMatch(/<form[^>]+id="connect-grok"/);
    expect(html).toMatch(/<form[^>]+id="connect-hook"/);
    expect(html).toContain('name="bearer_token"');
    expect(html).toContain("When a webhook fires");
    expect(html).toContain("Connect Grok Bot");
    // ChatGPT only receives events in dots and Work chats; say so, and give the prompt to paste.
    expect(html).toContain("dot");
    expect(html).toContain("Work chat");
    expect(html).toContain("No authentication");
    expect(html).toContain("Refresh tools");
    expect(html).toContain('id="gpt-prompt"');
    // Instruction for the Grok routine, ready to paste.
    expect(html).toContain('id="grok-instruction"');
  });

  it("ships an inline script that parses, in both languages", async () => {
    for (const path of ["/", "/?lang=zh"]) {
      const html = await (await get(path)).text();
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
      expect(scripts.length).toBeGreaterThan(0);
      for (const js of scripts) expect(() => new Function(js)).not.toThrow();
    }
  });

  it("shows when the bulletin was last checked", async () => {
    await env.DB.prepare("INSERT INTO poll_state (key, value, updated_at) VALUES ('health', ?, ?)")
      .bind(JSON.stringify({ checked_at: "2026-10-04T03:00:00.000Z", outcome: "unchanged" }), "2026-10-04T03:00:00.000Z")
      .run();
    const html = await (await get("/")).text();
    expect(html).toMatch(/<time class="checked" datetime="2026-10-04T03:00:00.000Z"/);
  });

  it("has a large share card for X and other link previews", async () => {
    const html = await (await get("/")).text();
    // The latest bulletin's card (test/card.test.ts covers rendering and the static fallback).
    expect(html).toContain('<meta property="og:image" content="https://vb.example/og/2026-10-B.png">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
  });

  it("breaks the headline between clauses, never inside one", async () => {
    const en = await (await get("/?lang=en")).text();
    expect(en).toContain('<h1><span class="l">Green card dates,</span> <span class="l">the minute they move.</span></h1>');
    const zh = await (await get("/?lang=zh")).text();
    expect(zh).toContain('<h1><span class="l">排期一动，</span> <span class="l">你第一个知道。</span></h1>');
  });

  it("leads with one sentence that has the agent set itself up", async () => {
    const html = await (await get("/")).text();
    // No assumption about the visitor's country or category.
    expect(html).toContain('<code id="setup-sentence">Read https://vb.example/setup.md and set up Visa Bulletin alerts for me.</code>');
    expect(html).not.toMatch(/id="(gpt-prompt|grok-instruction)">[^<]*China mainland EB-3/);
    // The manual steps are still there, folded away.
    expect(html).toMatch(/<details[^>]+id="by-hand"/);
    // No confusing unsubscribe form on the page; agents (or the stop link) handle it.
    expect(html).not.toContain('id="stop-alerts"');
    const zh = await (await get("/?lang=zh")).text();
    expect(zh).toContain('<code id="setup-sentence">读一下 https://vb.example/setup.md ，帮我设置美国签证排期推送。</code>');
  });

  it("uses color for hierarchy without loud blocks or hard offset shadows", async () => {
    const html = await (await get("/")).text();
    const css = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
    expect(css).not.toMatch(/box-shadow:\s*\d+px \d+px 0 /); // neo-brutalist offset shadow
    expect(css).not.toMatch(/mark\{[^}]*background:var\(--accent\)/); // the date is colored text, not a block
    // Color carries the hierarchy: one filled primary action, a tinted hero, a tinted USCIS column.
    expect(css).toMatch(/\.btn-primary\{[^}]*background:var\(--accent\)/);
    expect(css).toMatch(/\.hero\{[^}]*background:linear-gradient/);
    expect(css).toMatch(/td\.on,th\.on\{[^}]*background:var\(--accent-soft\)/);
  });

  it("takes the author bio from config, in each language", async () => {
    expect(await (await get("/?lang=en")).text()).toContain("Test bio in English.");
    expect(await (await get("/?lang=zh")).text()).toContain("测试用的中文介绍。");
  });

  it("renders no author section, follow button or personal link when no author is configured", () => {
    const html = renderHome("https://vb.example", null, null, "en", null, null);
    expect(html).not.toContain('id="author"');
    expect(html).not.toContain("x.com/");
    expect(html).not.toContain("twitter:creator");
  });

  it("links the source code next to the follow button, in the nav and the author section", async () => {
    for (const path of ["/", "/?lang=zh"]) {
      const html = await (await get(path)).text();
      const gh = 'href="https://github.com/example/visa-bulletin-push"';
      expect(html).toMatch(new RegExp(`<a class="btn btn-line gh" ${gh}[^>]*>[\\s\\S]*?GitHub</span></a>\\s*<a class="btn btn-line follow"`));
      const author = html.slice(html.indexOf('id="author"'));
      expect(author).toContain(gh);
    }
  });

  it("shows no GitHub link when SOURCE_URL is not configured", () => {
    const html = renderHome("https://vb.example", null, null, "en", null, { name: "Ada", x: "ada_example" });
    expect(html).not.toContain("github.com");
  });

  it("keeps the copy short", async () => {
    const html = await (await get("/")).text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<pre[\s\S]*?<\/pre>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    expect(text.split(" ").length).toBeLessThan(700);
  });

  it("shows month-over-month moves against the previous bulletin", async () => {
    const html = await (await get("/")).text();
    expect(html).toContain("+26 mo 24 d"); // CN EB3 chart B, Sep 2022-01-08 -> Oct 2024-04-01
    expect(html).toContain("No change"); // CN EB1 chart A
    expect(html).toContain("Reopened"); // IN EB2 chart A, U -> 2013-11-01
  });

  it("embeds the data the checker needs as inert JSON", async () => {
    const html = await (await get("/")).text();
    const m = html.match(/<script type="application\/json" id="vb-data">([^<]*)<\/script>/);
    expect(m).not.toBeNull();
    const data = JSON.parse(m![1]!);
    expect(data.bulletin).toBe("2026-10");
    expect(data.chart).toBe("B");
    expect(data.dates.CN.EB3.B).toBe("2024-04-01");
  });

  it("serves a complete Chinese page with ?lang=zh or a Chinese Accept-Language", async () => {
    for (const res of [await get("/?lang=zh"), await get("/", { headers: { "accept-language": "zh-CN,zh;q=0.9" } })]) {
      const html = await res.text();
      expect(html).toContain('<html lang="zh-CN"');
      expect(html).toContain("这个月我能递 I-485 吗？");
      expect(html).toContain("关注 @ada_example");
      expect(html).toContain("非官方整理，非法律意见");
      expect(html).toContain("+26 个月 24 天");
    }
    const en = await (await get("/?lang=en", { headers: { "accept-language": "zh-CN" } })).text();
    expect(en).toContain('<html lang="en"');
  });

  it("varies the cache on language", async () => {
    const res = await get("/");
    expect(res.headers.get("vary")).toContain("Accept-Language");
  });
});

describe("agent skill", () => {
  it("serves SKILL.md with this deployment's URLs", async () => {
    const res = await get("/skill.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const md = await res.text();
    expect(md).toMatch(/^---\nname: visa-bulletin\n/);
    expect(md).toContain("description: Use when");
    expect(md).toContain("https://vb.example/v1/latest.json");
    expect(md).toContain("https://vb.example/mcp");
    expect(md).toContain("https://vb.example/v1/webhooks");
  });
});

describe("agent setup instructions", () => {
  it("serves setup.md for every supported agent, with this deployment's URLs", async () => {
    const res = await get("/setup.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const md = await res.text();
    for (const s of ["Grok Bot", "ChatGPT", "Claude Code", "webhook", "Stop alerts"]) expect(md).toContain(s);
    expect(md).toContain("https://vb.example/v1/webhooks");
    expect(md).toContain("https://vb.example/mcp");
    expect(md).toContain("When a webhook fires");
    expect(md).toContain("ask your user");
    expect(md).not.toContain("for example \"China mainland EB-3\"");
    expect(md).toContain("manage_token");
    expect(md).toContain("https://vb.example/stop#id=");
    expect(md).toContain("# Set up Visa Bulletin alerts (vb.example)");
  });

  it("ends every push setup with a test alert the user actually sees", async () => {
    const md = await (await get("/setup.md")).text();
    // Webhook agents send the test themselves, and know what to say when it arrives.
    expect(md).toContain("POST https://vb.example/v1/webhooks/<id>/test");
    expect(md).toMatch(/If event is test, tell me/);
    expect(md).toMatch(/\{"delivered": true, "status": 200\}/);
    // ChatGPT gets the welcome event without asking for it.
    expect(md).toMatch(/starts with `TEST`/);
  });
});

describe("push, the reason to use this", () => {
  it("says why a push beats asking an agent, and which agents take pushes, in both languages", async () => {
    const en = (await (await get("/")).text()).replace(/&#39;/g, "'");
    expect(en).toContain("Can't my AI agent just look it up?");
    expect(en).toContain("can't tell whether what it found is this month's bulletin");
    expect(en).toContain("you never have to ask");
    expect(en).toContain("Pushes to ChatGPT (dots and Work chats), Grok Bot routines");
    expect(en.indexOf("Can't my AI agent just look it up?")).toBeLessThan(en.indexOf("Is this official?"));
    const zh = await (await get("/?lang=zh")).text();
    expect(zh).toContain("让 AI 自己查一下不就行了？");
    expect(zh).toContain("分不清搜到的是不是最新一期");
    expect(zh).toContain("不用你去问");
    expect(zh).toContain("推送支持 ChatGPT（dot 和 Work 对话）、Grok Bot 的 routine");
  });
});

describe("privacy answer", () => {
  it("says exactly which address is stored: the webhook URL, not a home address", async () => {
    const en = await (await get("/")).text();
    expect(en).toContain("the webhook URL your agent receives alerts at");
    expect(en).toContain("No name, email, home address or priority date.");
    expect(en).toContain("one-way hash of your IP address");
    const zh = await (await get("/?lang=zh")).text();
    expect(zh).toContain("webhook 网址（回调地址）");
    expect(zh).toContain("不保存姓名、邮箱、住址或优先日。");
    expect(zh).not.toContain("webhook 只保存你的地址");
  });
});

describe("author section", () => {
  it("shows the author's name without an initials badge", async () => {
    const html = await (await get("/")).text();
    expect(html).toContain('id="author"');
    expect(html).not.toContain('class="avatar"');
  });
});

describe("search wording", () => {
  it("names EB-2 explicitly in the title, description and first lines, in both languages", async () => {
    for (const path of ["/", "/?lang=zh"]) {
      const html = await (await get(path)).text();
      const title = html.match(/<title>([^<]*)<\/title>/)![1]!;
      const desc = html.match(/<meta name="description" content="([^"]*)"/)![1]!;
      const lede = html.match(/<p class="lede">([\s\S]*?)<\/p>/)![1]!;
      for (const text of [title, desc, lede]) expect(text).toContain("EB-2");
      expect(html).not.toMatch(/EB-?1 ?(to|至|–|-) ?EB-?3/);
    }
    for (const path of ["/setup.md", "/skill.md"]) {
      expect(await (await get(path)).text()).not.toMatch(/EB-?1 ?(to|至|–|-) ?EB-?3/);
    }
  });
});

describe("test alert on the page", () => {
  it("the Grok instruction answers a test, and the connect forms send one right after connecting", async () => {
    const html = await (await get("/")).text();
    expect(html).toContain("If it is a test, tell me alerts are working");
    expect(html).toContain('"/test"');
    expect(html).toContain("Send a test alert");
    expect(html).toContain("test alert");
    const zh = await (await get("/?lang=zh")).text();
    expect(zh).toContain("发一条测试推送");
  });

  it("the stop page can also send a test alert", async () => {
    const html = await (await get("/stop")).text();
    expect(html).toContain('"/test"');
    expect(html).toContain('method:"POST"');
    expect(html).toContain("Send a test alert");
  });

  it("skill.md documents the test endpoint", async () => {
    const md = await (await get("/skill.md")).text();
    expect(md).toContain("/v1/webhooks/{id}/test");
  });
});

describe("stop link", () => {
  it("serves a page that reads the id and token from the fragment and deletes the subscription", async () => {
    const res = await get("/stop");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("location.hash");
    expect(html).toContain('method:"DELETE"');
    const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    for (const j of js) expect(() => new Function(j)).not.toThrow();
  });
});
