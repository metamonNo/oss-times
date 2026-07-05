#!/usr/bin/env node
/**
 * 掲載申請Issue（掲載申請 + approved ラベル）を data/custom.json に取り込む。
 * GitHub Actions（issues: labeled）から GITHUB_EVENT_PATH 経由で実行される。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CUSTOM = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "custom.json");
const ADULT = /\bnsfw\b|porn|hentai|xxx|18\+|erotic|onlyfans|casino|gambl/i;
const SCAM = /crack(ed)?\b|keygen|free-?robux|hack\s?tool|phishing/i;

const evPath = process.env.GITHUB_EVENT_PATH;
if (!evPath) { console.error("GITHUB_EVENT_PATH がありません"); process.exit(1); }
const ev = JSON.parse(readFileSync(evPath, "utf8"));
const issue = ev.issue;
if (!issue) { console.error("issueイベントではありません"); process.exit(0); }
const labels = (issue.labels || []).map((l) => l.name);
if (!(labels.includes("掲載申請") && labels.includes("approved"))) {
  console.error("掲載申請+approved のIssueではないためスキップ"); process.exit(0);
}

const body = issue.body || "";
const grab = (h) => {
  const m = body.match(new RegExp("### " + h + "\\s*\\n+([\\s\\S]*?)(?=\\n### |$)"));
  const v = m ? m[1].trim() : "";
  return v === "_No response_" ? "" : v;
};
const name = grab("サービス名").slice(0, 80);
const url = grab("URL").trim();
const desc = grab("サービス概要").slice(0, 300);
const tags = grab("タグ").split(/[,、]/).map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 6);

if (!name || !desc || !/^https:\/\/\S+$/.test(url)) {
  console.error("必須項目不足またはURL形式不正（https必須）"); process.exit(1);
}
const hay = [name, desc, tags.join(" "), url].join(" ");
if (ADULT.test(hay) || SCAM.test(hay)) {
  console.error("掲載ポリシー違反の可能性があるため自動取込を拒否（手動確認してください）"); process.exit(1);
}

let data = { items: [] };
if (existsSync(CUSTOM)) { try { data = JSON.parse(readFileSync(CUSTOM, "utf8")); } catch {} }
data.items = data.items || [];
const norm = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, "") + x.pathname).replace(/\/+$/, "").toLowerCase(); } catch { return u; } };
if (data.items.some((i) => i.h && norm(i.h) === norm(url))) {
  console.error("同一URLが既に掲載されています"); process.exit(0);
}
data.items.push({
  n: name, f: "sub-" + issue.number, h: url, u: url,
  o: "@" + (issue.user?.login || "anonymous"), d: desc, t: tags,
  s: 0, c: new Date().toISOString(),
});
writeFileSync(CUSTOM, JSON.stringify(data, null, 2));
console.error(`追加しました: ${name} (${url}) by @${issue.user?.login}`);
