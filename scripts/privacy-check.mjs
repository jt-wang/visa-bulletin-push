// Fails if anything git would commit contains a term from .privacy-denylist. The list is
// git-ignored so it never ships. One term per line, case-insensitive; a line "word:<term>" matches
// only as a whole word (for short terms that also occur inside ordinary words).
//
// Checked: every file git would commit, as UTF-8 and as raw bytes; the term split by spaces, dots,
// dashes, underscores or zero-width characters; the term in base64 at any alignment; long base64
// blobs and zlib (PDF) streams, decoded; the git author and committer identity, from config and
// from the environment; and the timezone, because every commit records the local UTC offset.
// Not checked: text drawn in image pixels. Look at images yourself.
//
// The identity you chose to publish under may contain a denylisted term (your public handle, kept
// out of the files). List its exact name and email, one per line, in .privacy-allow-identity
// (git-ignored); only those exact values are exempt, and only in the commit identity.
//
// `npm run privacy-hook` installs it as .git/hooks/pre-commit, so commits must run under TZ=UTC.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

if (!existsSync(".privacy-denylist")) {
  console.error("privacy-check: no .privacy-denylist file; create one (one term per line).");
  process.exit(2);
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEPARATORS = /[\s._\-​-‍⁠﻿]+/g;
const terms = readFileSync(".privacy-denylist", "utf8")
  .split("\n")
  .map((t) => t.trim())
  .filter((t) => t && !t.startsWith("#"))
  .map((line, i) => {
    const word = line.startsWith("word:");
    const term = (word ? line.slice(5) : line).toLowerCase();
    return {
      n: i + 1,
      term,
      squeezed: term.replace(SEPARATORS, ""),
      re: word ? new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, "iu") : null,
    };
  });

function hits(text) {
  const lower = text.toLowerCase();
  const squeezed = lower.replace(SEPARATORS, "");
  const found = new Set();
  for (const t of terms) {
    if (t.re ? t.re.test(text) : lower.includes(t.term) || (t.squeezed.length >= 5 && squeezed.includes(t.squeezed))) found.add(t.n);
  }
  return found;
}

// The base64 of a term at each of the three byte alignments, trimmed to the characters that do
// not depend on the neighbouring bytes. Base64 is case-sensitive, so common casings are included.
function base64Forms(term) {
  const forms = [];
  for (const c of new Set([term, term.toUpperCase(), term[0].toUpperCase() + term.slice(1)])) {
    const bytes = Buffer.from(c, "utf8");
    if (bytes.length < 5) continue;
    for (let pad = 0; pad < 3; pad++) {
      const enc = Buffer.concat([Buffer.alloc(pad), bytes]).toString("base64");
      forms.push(enc.slice(Math.ceil((pad * 4) / 3), Math.floor(((pad + bytes.length) * 4) / 3)));
    }
  }
  return forms;
}
const b64 = terms.filter((t) => !t.re).map((t) => ({ n: t.n, forms: base64Forms(t.term) }));

// Contents hidden inside a file: long base64 runs and zlib streams (PDF FlateDecode), decoded.
function hiddenLayers(buf, depth = 0) {
  if (depth > 2) return [];
  const out = [];
  const latin = buf.toString("latin1");
  for (const m of latin.matchAll(/[A-Za-z0-9+/]{200,}={0,2}/g)) {
    const dec = Buffer.from(m[0], "base64");
    out.push(dec, ...hiddenLayers(dec, depth + 1));
  }
  for (const m of latin.matchAll(/stream\r?\n/g)) {
    try {
      out.push(inflateSync(buf.subarray(m.index + m[0].length), { finishFlush: 2 }));
    } catch {}
  }
  return out;
}

let bad = 0;
function report(where, found) {
  for (const n of found) {
    console.error(`privacy-check: ${where} contains a denylisted term (#${n})`);
    bad++;
  }
}

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
for (const f of files) {
  if (!existsSync(f)) continue;
  const buf = readFileSync(f);
  const raw = buf.toString("latin1");
  const found = new Set([...hits(buf.toString("utf8")), ...hits(raw)]);
  for (const { n, forms } of b64) if (forms.some((x) => raw.includes(x))) found.add(n);
  for (const layer of hiddenLayers(buf)) for (const n of hits(layer.toString("latin1"))) found.add(n);
  report(f, found);
}

// Commit metadata: who the next commit says wrote it, from config and from the environment.
const identity = {};
for (const key of ["user.name", "user.email"]) {
  try {
    identity[`git ${key}`] = execFileSync("git", ["config", key], { encoding: "utf8" }).trim();
  } catch {}
}
for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) {
  if (process.env[key]) identity[key] = process.env[key];
}
const allowed = existsSync(".privacy-allow-identity")
  ? new Set(readFileSync(".privacy-allow-identity", "utf8").split("\n").map((l) => l.trim()).filter(Boolean))
  : new Set();
for (const [where, value] of Object.entries(identity)) if (!allowed.has(value)) report(where, hits(value));
if (new Date().getTimezoneOffset() !== 0) {
  console.error("privacy-check: local timezone is not UTC, and commits record it. Run with TZ=UTC.");
  bad++;
}
for (const key of ["GIT_AUTHOR_DATE", "GIT_COMMITTER_DATE"]) {
  const v = process.env[key];
  if (v && /[+-]\d\d:?\d\d\s*$/.test(v) && !/[+-]00:?00\s*$/.test(v)) {
    console.error(`privacy-check: ${key} carries a non-UTC offset.`);
    bad++;
  }
}

if (bad) process.exit(1);
console.log(`privacy-check: ${files.length} files and the commit identity are clean against ${terms.length} terms.`);
