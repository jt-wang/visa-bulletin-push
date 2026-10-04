// Agent skill served at /skill.md, with this deployment's URLs filled in.

export function renderSkill(origin: string): string {
  return `---
name: visa-bulletin
description: Use when the user asks about US green card priority dates, the Visa Bulletin, whether they can file I-485 this month, or wants alerts when China or India EB-1/EB-2/EB-3 cutoff dates move.
---

# Visa Bulletin (China and India, EB-1, EB-2, EB-3)

Unofficial, machine-readable data from the US State Department Visa Bulletin, plus the chart USCIS accepts for employment-based I-485 each month. Source and docs: ${origin}

## What the data means

- Chart **A** = Final Action Dates: when a green card can be approved.
- Chart **B** = Dates for Filing: when I-485 can be submitted early, if USCIS allows it that month.
- \`uscis.employment_chart\` says which chart USCIS accepts this month (\`A\`, \`B\`, or missing if not announced yet).
- A priority date is current when it is **earlier** than the cutoff. \`C\` = current for everyone, \`U\` = unavailable.
- Countries: \`CN\` (China mainland-born), \`IN\` (India). Categories: \`EB1\`, \`EB2\`, \`EB3\`.

## Read the latest dates

\`\`\`bash
curl -s ${origin}/v1/latest.json
curl -s ${origin}/v1/latest.json | jq '.dates.CN.EB3, .uscis.employment_chart'
\`\`\`

Other endpoints: \`${origin}/v1/bulletins.json\` (index), \`${origin}/v1/bulletins/YYYY-MM.json\`, \`${origin}/feed.atom\`.

## Answer "can I file I-485 this month?"

1. Get the user's country of birth, category and priority date (YYYY-MM-DD). Do not send it anywhere; compute locally.
2. Read \`uscis.employment_chart\`. If missing, say USCIS has not announced the chart yet.
3. Compare the priority date with \`dates[country][category][chart]\`: earlier than the cutoff, or \`C\`, means they can file.
4. Also report chart A: approval waits until chart A is current.
5. Always add: unofficial, not legal advice; confirm with travel.state.gov and uscis.gov.

## MCP

Remote MCP server (stateless, streamable HTTP): \`${origin}/mcp\`

\`\`\`bash
claude mcp add --transport http visa-bulletin ${origin}/mcp
\`\`\`

Tools: \`get_latest_dates\`, \`get_bulletin\`, \`check_priority_date\`.

## Alerts (webhooks)

\`\`\`bash
curl -X POST ${origin}/v1/webhooks \\
  -H 'content-type: application/json' \\
  -d '{"url": "https://example.com/hooks/visa", "bearer_token": "optional"}'
\`\`\`

- A signed \`ping\` is sent first; the URL must answer 2xx.
- The response contains \`signing_secret\` and \`manage_token\` once. Store them securely; never print them back to the user in shared logs.
- Events: \`bulletin.published\`, \`bulletin.updated\`, \`uscis.chart_decided\`. Body: \`{source, event, message, sent_at, data}\`.
- Verify: \`X-VB-Signature = "sha256=" + hex(HMAC_SHA256(signing_secret, X-VB-Timestamp + "." + raw_body))\`.
- Test: \`POST ${origin}/v1/webhooks/{id}/test\` with \`Authorization: Bearer <manage_token>\` sends event \`test\` with the current snapshot now (at most 10 a day).
- Unsubscribe: \`DELETE ${origin}/v1/webhooks/{id}\` with \`Authorization: Bearer <manage_token>\`.
`;
}
