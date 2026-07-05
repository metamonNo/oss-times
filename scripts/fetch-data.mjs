#!/usr/bin/env node
/**
 * OSS TIMES データ収集スクリプト v3
 * 巡回先: GitHub / GitLab / Codeberg / HF Spaces / Show HN / Reddit / Dev.to / Bluesky (+手動掲載 custom.json)
 * - 説明文を日本語へ自動翻訳（前回data.jsonをキャッシュ再利用）
 * - 用途カテゴリ（介護・医療、EC・フリマ、ネットワーク・WiFi等）を自動付与
 * - 巡回ごとに紹介記事を自動生成（GROQ_API_KEYがあればLLM執筆、無ければテンプレート）
 * - テスト: node scripts/fetch-data.mjs --mock <mockfile.json>
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "data.json");
const ART = join(ROOT, "data", "articles.json");
const CUSTOM = join(ROOT, "data", "custom.json");
const TOKEN = process.env.GITHUB_TOKEN || "";
const GROQ = process.env.GROQ_API_KEY || "";
const SB_KEY = process.env.SAFE_BROWSING_API_KEY || "";
const mockIdx = process.argv.indexOf("--mock");
const MOCK = mockIdx > -1 ? JSON.parse(readFileSync(process.argv[mockIdx + 1], "utf8")) : null;

const daysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
const daysSince = (iso) => Math.max(0, (Date.now() - new Date(iso || 0).getTime()) / 864e5);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JA = /[぀-ヿ一-鿿]/;

/* ===== GitHubカテゴリ定義（index.html と同一に保つこと） ===== */
const CATEGORIES = [
  { id: "new", label: "新着リリース", queries: [
    [`created:>=${daysAgo(14)} stars:>=10`, 3],
    [`created:>=${daysAgo(30)} stars:>=30`, 2],
  ]},
  { id: "trending", label: "トレンド", queries: [
    [`created:>=${daysAgo(90)} stars:>=300`, 2],
  ]},
  { id: "selfhosted", label: "セルフホスト", queries: [
    [`topic:self-hosted stars:>=800 pushed:>=${daysAgo(365)}`, 1],
  ]},
  { id: "ai", label: "AI・LLM", queries: [
    [`topic:llm stars:>=1500 pushed:>=${daysAgo(180)}`, 1],
    [`topic:ai-agents stars:>=800 pushed:>=${daysAgo(180)}`, 1],
  ]},
  { id: "devtools", label: "開発ツール", queries: [
    [`topic:developer-tools stars:>=1000 pushed:>=${daysAgo(365)}`, 1],
    [`topic:devops stars:>=2500 pushed:>=${daysAgo(365)}`, 1],
  ]},
];
const PER_PAGE = 100;

/* ===== 除外ルール ===== */
const NAME_NOISE = /(^|[-_])awesome([-_]|$)|^awesome|roadmap|interview[-_]?(questions|university)?$|cheat[-_]?sheet|free[-_]programming|build[-_]your[-_]own|coding[-_]interview|system[-_]design[-_]primer|leetcode/i;
const TOPIC_NOISE = new Set(["awesome", "awesome-list", "roadmap", "interview", "interview-questions", "books", "tutorial"]);
const DESC_NOISE = /\b(awesome list|curated list|a list of|collection of (links|resources)|interview questions|study (plan|guide))\b/i;
const ADULT = /\bnsfw\b|porn|hentai|xxx|18\+|not-for-all-audiences|erotic|onlyfans/i;
const isNoise = (name, topics, desc) =>
  NAME_NOISE.test(name || "") ||
  (topics || []).some((t) => TOPIC_NOISE.has(t)) ||
  DESC_NOISE.test(desc || "") ||
  ADULT.test([name, desc, ...(topics || [])].join(" "));

/* ===== 用途カテゴリ（index.html と同一に保つこと・日本語ラベルが正準値） ===== */
const USECASES = [
  ["🏥 介護・医療・健康", /\b(care|health|medical|clinic|hospital|patient|ehr|fhir|elder|nursing|fitness|workout|mental|medication)\b/],
  ["🛒 EC・フリマ・オークション", /\b(e-?commerce|marketplace|auctions?|resale|resell(er)?|shop(s|ping)?|shopify|storefront|pos|ebay|mercari|flea-?market|second-?hand|selling)\b/],
  ["🏠 家庭・スマートホーム", /\b(home-?assistant|home-?automation|smart-?home|household|family)\b|\biot\b/],
  ["📶 ネットワーク・WiFi", /\b(network(ing)?|wi-?fi|speedtest|bandwidth|router|dns|ping|firewall|proxy|vpn)\b/],
  ["💰 家計・会計・お金", /\b(finance|budget|accounting|money|expense|invoice|billing|tax|banking)\b/],
  ["📚 学習・教育", /\b(learn(ing)?|education|study|flashcard|anki|quiz|language-?learning|school)\b/],
  ["🍳 料理・レシピ", /\b(recipe|cooking|meal|grocery|kitchen|food)\b/],
  ["📷 写真・動画・メディア", /\b(photo|image|video|media-?server|gallery|camera|streaming|movie|tv)\b/],
  ["🎵 音楽・音声", /\b(music|audio|podcast|spotify|sound|speech|voice|tts)\b/],
  ["✈️ 旅行・地図・移動", /\b(travel|trip|maps?|gps|geo|location|transit|flight|navigation)\b/],
  ["📅 予定・予約・時間管理", /\b(calendar|booking|reservation|schedul\w*|appointment|time-?track\w*)\b/],
  ["📝 メモ・文書・知識", /\b(notes?|wiki|documents?|markdown|pdf|knowledge|writing|journal|bookmark)\b/],
  ["💬 チャット・コミュニティ", /\b(chat|messag\w*|forum|community|social|discord|slack|matrix|comments?)\b/],
  ["🏢 業務・バックオフィス", /\b(crm|erp|hr\b|inventory|warehouse|payroll|helpdesk|tickets?|workflow|automation|no-?code|low-?code)\b/],
  ["🎮 ゲーム・趣味", /\b(games?|gaming|manga|anime|books?|reading|collection|hobby)\b/],
  ["🔐 セキュリティ・プライバシー", /\b(password|security|privacy|encrypt\w*|auth\w*|2fa|sso)\b/],
  ["📊 データ・分析・可視化", /\b(analytics|dashboards?|visuali[sz]\w*|charts?|reports?|metrics|monitor\w*|observability)\b/],
  ["🤖 AI活用", /\b(ai|llm|gpt|agents?|rag|chatbots?|diffusion|whisper|machine-?learning|deep-?learning|transformers?)\b/],
  ["🛠 開発・技術", /\b(developer|devops|api|framework|kubernetes|docker|ci\/?cd|testing|git|terminal|database|sql)\b/],
];
const ucOf = (name, topics, desc) => {
  const hay = ((topics || []).join(" ") + " " + (name || "") + " " + (desc || "")).toLowerCase();
  const out = [];
  for (const [label, re] of USECASES) { if (re.test(hay)) { out.push(label); if (out.length >= 3) break; } }
  return out;
};

const SRCJP = { gh: "GitHub", gl: "GitLab", cb: "Codeberg", hf: "HF Spaces", hn: "Show HN", rd: "Reddit", dv: "Dev.to", bs: "Bluesky", qi: "Qiita", zn: "Zenn", own: "手動掲載" };
const normUrl = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, "") + x.pathname).replace(/\/+$/, "").toLowerCase(); } catch { return String(u); } };
const isGithubUrl = (u) => { try { return /(^|\.)github\.com$/.test(new URL(u).hostname); } catch { return false; } };

async function api(url, headers = {}) {
  const res = await fetch(url, { headers: { "User-Agent": "oss-times-portal/1.0", ...headers } });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

/* ===== コード系ソース ===== */
async function fetchGitHub(results) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const interval = TOKEN ? 2200 : 6500;
  let first = true;
  for (const cat of CATEGORIES) {
    for (const [q, pages = 1] of cat.queries) {
      for (let page = 1; page <= pages; page++) {
        let raw;
        if (MOCK) { if (page > 1) break; raw = MOCK.github || []; }
        else {
          if (!first) await sleep(interval);
          first = false;
          console.error(`[gh:${cat.id}] ${q} (p${page})`);
          let ok = false;
          for (let a = 1; a <= 3 && !ok; a++) {
            try {
              raw = (await api(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${PER_PAGE}&page=${page}`, headers)).items || [];
              ok = true;
            } catch (e) { if (a === 3) throw e; console.error(`  retry (${e.message})`); await sleep(65000); }
          }
          if (!raw.length) break; // 最終ページ到達
        }
        for (const r of raw) {
          if (r.archived || r.fork || isNoise(r.name, r.topics, r.description)) continue;
          const key = "gh/" + r.full_name;
          const cur = results.get(key) || {
            src: "gh", f: r.full_name, n: r.name, o: r.owner?.login || "", a: r.owner?.avatar_url || "",
            u: r.html_url, h: (r.homepage || "").trim() || null, d: r.description || "", dj: null, e: null,
            s: r.stargazers_count || 0, fk: r.forks_count || 0, l: r.language || null,
            t: (r.topics || []).slice(0, 6),
            lic: r.license && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : null,
            c: r.created_at, p: r.pushed_at, cats: [],
          };
          if (!cur.cats.includes(cat.id)) cur.cats.push(cat.id);
          results.set(key, cur);
        }
      }
    }
  }
}

function deriveCats(topics, createdAt) {
  const s = new Set(topics || []);
  const cats = [];
  const age = daysSince(createdAt);
  if (age <= 30) cats.push("new");
  else if (age <= 90) cats.push("trending");
  if (s.has("self-hosted") || s.has("selfhosted")) cats.push("selfhosted");
  if (["llm", "ai", "ai-agents", "machine-learning", "deep-learning", "rag", "chatbot", "gpt"].some((t) => s.has(t))) cats.push("ai");
  if (["developer-tools", "devops", "kubernetes", "cli", "ci", "cicd", "monitoring"].some((t) => s.has(t))) cats.push("devtools");
  return cats;
}

async function fetchGitLab(results) {
  console.error("[gitlab]");
  let raw;
  try { raw = MOCK ? (MOCK.gitlab || []) : await api("https://gitlab.com/api/v4/projects?order_by=star_count&sort=desc&per_page=60&visibility=public"); }
  catch (e) { console.error("  gitlab失敗: " + e.message); return; }
  for (const p of raw) {
    if ((p.star_count || 0) < 300 || isNoise(p.name, p.topics, p.description)) continue;
    results.set("gl/" + p.path_with_namespace, {
      src: "gl", f: p.path_with_namespace, n: p.name, o: (p.path_with_namespace || "").split("/")[0],
      a: p.avatar_url || p.namespace?.avatar_url || "", u: p.web_url, h: null, d: p.description || "", dj: null, e: null,
      s: p.star_count || 0, fk: p.forks_count || 0, l: null, t: (p.topics || []).slice(0, 6), lic: null,
      c: p.created_at, p: p.last_activity_at, cats: deriveCats(p.topics, p.created_at),
    });
  }
}

async function fetchCodeberg(results) {
  console.error("[codeberg]");
  let raw;
  try { raw = MOCK ? (MOCK.codeberg || []) : (await api("https://codeberg.org/api/v1/repos/search?sort=stars&order=desc&limit=50")).data || []; }
  catch (e) { console.error("  codeberg失敗: " + e.message); return; }
  for (const r of raw) {
    if ((r.stars_count || 0) < 50 || r.archived || r.fork || isNoise(r.name, r.topics, r.description)) continue;
    results.set("cb/" + r.full_name, {
      src: "cb", f: r.full_name, n: r.name, o: r.owner?.login || "", a: r.owner?.avatar_url || r.avatar_url || "",
      u: r.html_url, h: (r.website || "").trim() || null, d: r.description || "", dj: null, e: null,
      s: r.stars_count || 0, fk: r.forks_count || 0, l: r.language || null, t: (r.topics || []).slice(0, 6), lic: null,
      c: r.created_at, p: r.updated_at, cats: deriveCats(r.topics, r.created_at),
    });
  }
}

async function fetchHuggingFace(results) {
  console.error("[hf] Spaces");
  let raw;
  try { raw = MOCK ? (MOCK.hf || []) : await api("https://huggingface.co/api/spaces?sort=likes&direction=-1&limit=200&full=true"); }
  catch (e) { console.error("  hf失敗: " + e.message); return; }
  for (const sp of raw) {
    if ((sp.likes || 0) < 50) continue;
    const tags = (sp.tags || []).filter((t) => !t.includes(":"));
    const title = sp.cardData?.title || sp.id?.split("/")[1] || "";
    const desc = sp.cardData?.short_description || title;
    if (isNoise(title, tags, desc)) continue;
    const url = "https://huggingface.co/spaces/" + sp.id;
    const created = sp.createdAt || sp.lastModified || new Date().toISOString();
    results.set("hf/" + sp.id, {
      src: "hf", f: sp.id, n: title || sp.id.split("/")[1], o: sp.id.split("/")[0], a: "",
      u: url, h: url, d: desc, dj: null, e: sp.cardData?.emoji || null,
      s: sp.likes || 0, fk: 0, l: sp.sdk || sp.cardData?.sdk || null, t: tags.slice(0, 6), lic: null,
      c: created, p: sp.lastModified || created,
      cats: ["ai", ...deriveCats(tags, created).filter((c) => c !== "ai")],
    });
  }
}

/* ===== SNS系ソース（個人開発の告知場所） ===== */
const snsSeen = new Map(); // normUrl -> key（重複時はスコア高い方を残す）
function putSns(results, key, item) {
  if (item.h && isGithubUrl(item.h)) return;           // GitHubリンクは本体巡回と重複するため除外
  if (isNoise(item.n, item.t, item.d)) return;
  const nu = item.h ? normUrl(item.h) : key;
  const prevKey = snsSeen.get(nu);
  if (prevKey) {
    const prev = results.get(prevKey);
    if (prev && prev.s >= item.s) return;
    results.delete(prevKey);
  }
  snsSeen.set(nu, key);
  item.uc = ucOf(item.n, item.t, item.d);
  results.set(key, item);
}

async function fetchHackerNews(results) {
  console.error("[hn] Show HN");
  let hits;
  const since = Math.floor(Date.now() / 1000) - 30 * 86400;
  try { hits = MOCK ? (MOCK.hn || []) : (await api(`https://hn.algolia.com/api/v1/search?tags=show_hn&numericFilters=points%3E%3D20,created_at_i%3E%3D${since}&hitsPerPage=100`)).hits || []; }
  catch (e) { console.error("  hn失敗: " + e.message); return; }
  for (const hh of hits) {
    if (!hh.url || (hh.points || 0) < 20) continue;
    const title = (hh.title || "").replace(/^show hn:?\s*/i, "");
    const created = new Date((hh.created_at_i || 0) * 1000).toISOString();
    let host = "web"; try { host = new URL(hh.url).hostname.replace(/^www\./, ""); } catch {}
    putSns(results, "hn/" + hh.objectID, {
      src: "hn", f: "hn:" + hh.objectID, n: title.slice(0, 80), o: host, a: "",
      u: "https://news.ycombinator.com/item?id=" + hh.objectID, h: hh.url,
      d: (hh.story_text ? String(hh.story_text).replace(/<[^>]+>/g, " ").slice(0, 240) : title), dj: null, e: null,
      s: hh.points || 0, fk: hh.num_comments || 0, l: null, t: [], lic: null,
      c: created, p: created, cats: ["new"],
    });
  }
}

async function fetchReddit(results) {
  const subs = [["SideProject", 80], ["selfhosted", 150], ["opensource", 100]];
  for (const [sub, min] of subs) {
    console.error(`[reddit] r/${sub}`);
    let posts;
    try { posts = MOCK ? (MOCK.reddit || []) : ((await api(`https://www.reddit.com/r/${sub}/top.json?t=week&limit=100&raw_json=1`)).data?.children || []).map((c) => c.data); }
    catch (e) { console.error("  reddit失敗: " + e.message); continue; }
    for (const p of posts) {
      const url = p.url_overridden_by_dest || p.url || "";
      if ((p.score || 0) < min || !url || /reddit\.com|redd\.it|imgur\.com/.test(url)) continue;
      const created = new Date((p.created_utc || 0) * 1000).toISOString();
      putSns(results, "rd/" + p.id, {
        src: "rd", f: "rd:" + p.id, n: (p.title || "").slice(0, 80), o: "r/" + sub, a: "",
        u: "https://www.reddit.com" + (p.permalink || ""), h: url,
        d: (p.selftext || p.title || "").slice(0, 240), dj: null, e: null,
        s: p.score || 0, fk: p.num_comments || 0, l: null, t: [sub.toLowerCase()], lic: null,
        c: created, p: created, cats: daysSince(created) <= 30 ? ["new"] : [],
      });
    }
    if (!MOCK) await sleep(1500);
  }
}

async function fetchDevto(results) {
  console.error("[devto] #showdev");
  let arts;
  try { arts = MOCK ? (MOCK.devto || []) : await api("https://dev.to/api/articles?tag=showdev&top=30&per_page=100"); }
  catch (e) { console.error("  devto失敗: " + e.message); return; }
  for (const a of arts) {
    if ((a.positive_reactions_count || 0) < 20) continue;
    putSns(results, "dv/" + a.id, {
      src: "dv", f: "dv:" + a.id, n: (a.title || "").slice(0, 80), o: a.user?.username || "dev.to", a: a.user?.profile_image_90 || "",
      u: a.url, h: a.url, d: a.description || a.title || "", dj: null, e: null,
      s: a.positive_reactions_count || 0, fk: a.comments_count || 0, l: null,
      t: (a.tag_list || []).slice(0, 6), lic: null,
      c: a.published_at, p: a.published_at, cats: daysSince(a.published_at) <= 30 ? ["new"] : [],
    });
  }
}

async function fetchBluesky(results) {
  console.error("[bluesky] #buildinpublic");
  let posts;
  try { posts = MOCK ? (MOCK.bluesky || []) : (await api("https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=%23buildinpublic&sort=top&limit=100")).posts || []; }
  catch (e) { console.error("  bluesky失敗: " + e.message); return; }
  for (const p of posts) {
    const ext = p.embed?.external;
    if (!ext?.uri || (p.likeCount || 0) < 15) continue;
    const rkey = String(p.uri || "").split("/").pop();
    const created = p.record?.createdAt || p.indexedAt;
    putSns(results, "bs/" + rkey, {
      src: "bs", f: "bs:" + rkey, n: (ext.title || p.record?.text || "").slice(0, 80), o: p.author?.handle || "bsky", a: p.author?.avatar || "",
      u: `https://bsky.app/profile/${p.author?.handle}/post/${rkey}`, h: ext.uri,
      d: (ext.description || p.record?.text || "").slice(0, 240), dj: null, e: null,
      s: p.likeCount || 0, fk: p.repostCount || 0, l: null, t: [], lic: null,
      c: created, p: created, cats: daysSince(created) <= 30 ? ["new"] : [],
    });
  }
}

/* ===== 日本発の深掘り（過去1ヶ月・低スター閾値） ===== */
async function fetchGitHubJapan(results) {
  if (MOCK) return;
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const queries = [
    `サービス created:>=${daysAgo(30)} stars:>=3`,
    `アプリ created:>=${daysAgo(30)} stars:>=3`,
    `個人開発 created:>=${daysAgo(45)} stars:>=1`,
    `日本語 created:>=${daysAgo(30)} stars:>=5`,
  ];
  for (const q of queries) {
    await sleep(TOKEN ? 2200 : 6500);
    console.error(`[gh:japan] ${q}`);
    let raw = [];
    try { raw = (await api(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${PER_PAGE}`, headers)).items || []; }
    catch (e) { console.error("  失敗: " + e.message); continue; }
    for (const r of raw) {
      if (r.archived || r.fork || isNoise(r.name, r.topics, r.description)) continue;
      const key = "gh/" + r.full_name;
      if (results.has(key)) { results.get(key).co = results.get(key).co || "JP"; continue; }
      const cats = deriveCats(r.topics, r.created_at);
      if ((Date.now() - new Date(r.created_at)) / 864e5 <= 30 && !cats.includes("new")) cats.unshift("new");
      results.set(key, {
        src: "gh", f: r.full_name, n: r.name, o: r.owner?.login || "", a: r.owner?.avatar_url || "",
        u: r.html_url, h: (r.homepage || "").trim() || null, d: r.description || "", dj: null, e: null,
        s: r.stargazers_count || 0, fk: r.forks_count || 0, l: r.language || null,
        t: (r.topics || []).slice(0, 6),
        lic: r.license && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : null,
        c: r.created_at, p: r.pushed_at, cats, co: "JP",
      });
    }
  }
}

async function fetchQiita(results) {
  console.error("[qiita] 個人開発タグ");
  let arts;
  try { arts = MOCK ? (MOCK.qiita || []) : await api("https://qiita.com/api/v2/items?query=tag%3A%E5%80%8B%E4%BA%BA%E9%96%8B%E7%99%BA&per_page=50"); }
  catch (e) { console.error("  qiita失敗: " + e.message); return; }
  for (const a of arts) {
    if ((a.likes_count || 0) < 5 || daysSince(a.created_at) > 45) continue;
    const links = [...String(a.rendered_body || "").matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
    const ext = links.find((u) => !/qiita\.com|zenn\.dev|github\.com|twitter\.com|x\.com|youtube|amazon|note\.com|apps\.apple|play\.google/.test(u)) || null;
    putSns(results, "qi/" + a.id, {
      src: "qi", f: "qi:" + a.id, n: (a.title || "").slice(0, 80), o: a.user?.id || "qiita", a: a.user?.profile_image_url || "",
      u: a.url, h: ext || a.url, d: a.title || "", dj: null, e: null,
      s: a.likes_count || 0, fk: a.comments_count || 0, l: null,
      t: (a.tags || []).map((t) => t.name).slice(0, 6), lic: null,
      c: a.created_at, p: a.updated_at || a.created_at,
      cats: daysSince(a.created_at) <= 30 ? ["new"] : [], co: "JP",
    });
  }
}

async function fetchZenn(results) {
  console.error("[zenn] 個人開発トピック");
  let arts;
  try { arts = MOCK ? (MOCK.zenn || []) : (await api("https://zenn.dev/api/articles?topicname=%E5%80%8B%E4%BA%BA%E9%96%8B%E7%99%BA&order=latest&count=48")).articles || []; }
  catch (e) { console.error("  zenn失敗: " + e.message); return; }
  for (const a of arts) {
    const created = a.published_at || a.body_updated_at;
    if ((a.liked_count || 0) < 10 || daysSince(created) > 45) continue;
    const url = "https://zenn.dev" + (a.path || "/" + (a.user?.username || "") + "/articles/" + a.slug);
    putSns(results, "zn/" + a.id, {
      src: "zn", f: "zn:" + a.id, n: (a.title || "").slice(0, 80), o: a.user?.username || "zenn", a: a.user?.avatar_small_url || "",
      u: url, h: url, d: a.title || "", dj: null, e: null,
      s: a.liked_count || 0, fk: a.comments_count || 0, l: null, t: ["個人開発"], lic: null,
      c: created, p: created, cats: daysSince(created) <= 30 ? ["new"] : [], co: "JP",
    });
  }
}

/* ===== 手動掲載（自作サービス等）: data/custom.json ===== */
function mergeCustom(results) {
  if (!existsSync(CUSTOM)) return;
  try {
    const list = JSON.parse(readFileSync(CUSTOM, "utf8")).items || [];
    for (const c of list) {
      const it = {
        src: c.src || "own", f: c.f || c.n, n: c.n, o: c.o || "", a: c.a || "",
        u: c.u || c.h || "#", h: c.h || null, d: c.d || "", dj: c.dj || (JA.test(c.d || "") ? c.d : null), e: c.e || null,
        s: c.s || 0, fk: 0, l: c.l || null, t: c.t || [], lic: c.lic || null,
        c: c.c || new Date().toISOString(), p: c.p || new Date().toISOString(),
        cats: c.cats || [], co: c.co || null, uc: c.uc || ucOf(c.n, c.t, (c.d || "") + " " + (c.dj || "")),
      };
      results.set("own/" + it.f, it);
    }
    console.error(`[custom] ${list.length}件を手動掲載`);
  } catch (e) { console.error("  custom.json読み込み失敗: " + e.message); }
}

/* ===== 国判定（GitHubオーナーのlocation → ccTLDフォールバック） ===== */
const TLD_CC = { jp:"JP",de:"DE",fr:"FR",uk:"GB",in:"IN",br:"BR",kr:"KR",tw:"TW",es:"ES",it:"IT",nl:"NL",pl:"PL",ru:"RU",ca:"CA",au:"AU",ch:"CH",se:"SE",no:"NO",fi:"FI",dk:"DK",cz:"CZ",at:"AT",be:"BE",pt:"PT",gr:"GR",tr:"TR",il:"IL",sg:"SG",id:"ID",th:"TH",vn:"VN",my:"MY",ph:"PH",mx:"MX",ar:"AR",cl:"CL",nz:"NZ",ie:"IE",ua:"UA",ee:"EE",lv:"LV",lt:"LT",hu:"HU",ro:"RO",bg:"BG",hr:"HR",rs:"RS",sk:"SK",si:"SI",cn:"CN",hk:"HK" };
function tldCountry(u) { try { const h = new URL(u).hostname; const tld = h.split(".").pop().toLowerCase(); return TLD_CC[tld] || null; } catch { return null; } }
const LOC_CC = [
  [/japan|tokyo|osaka|kyoto|nagoya|fukuoka|日本|東京|大阪/i,"JP"],[/united states|\busa\b|\bus\b$|san francisco|new york|seattle|austin|boston|california|texas|chicago|los angeles|silicon valley/i,"US"],
  [/germany|berlin|munich|hamburg|deutschland/i,"DE"],[/france|paris|lyon/i,"FR"],[/united kingdom|\buk\b|london|england|scotland/i,"GB"],
  [/india|bangalore|bengaluru|mumbai|delhi|hyderabad|chennai|pune/i,"IN"],[/china|beijing|shanghai|shenzhen|hangzhou|guangzhou|中国|北京|上海|深圳|杭州/i,"CN"],
  [/canada|toronto|vancouver|montreal/i,"CA"],[/australia|sydney|melbourne/i,"AU"],[/brazil|brasil|s[aã]o paulo|rio de janeiro/i,"BR"],
  [/netherlands|amsterdam|holland/i,"NL"],[/spain|madrid|barcelona/i,"ES"],[/italy|milan|rome|italia/i,"IT"],[/poland|warsaw|krak[oó]w/i,"PL"],
  [/russia|moscow|st\.? ?petersburg/i,"RU"],[/korea|seoul|서울/i,"KR"],[/taiwan|taipei|台湾|台北/i,"TW"],[/singapore/i,"SG"],
  [/switzerland|zurich|geneva/i,"CH"],[/sweden|stockholm/i,"SE"],[/norway|oslo/i,"NO"],[/finland|helsinki/i,"FI"],[/denmark|copenhagen/i,"DK"],
  [/austria|vienna/i,"AT"],[/belgium|brussels/i,"BE"],[/portugal|lisbon/i,"PT"],[/turkey|istanbul|ankara/i,"TR"],[/israel|tel aviv/i,"IL"],
  [/ukraine|kyiv|kiev/i,"UA"],[/czech|prague/i,"CZ"],[/ireland|dublin/i,"IE"],[/mexico|cdmx/i,"MX"],[/argentina|buenos aires/i,"AR"],
  [/vietnam|hanoi|ho chi minh/i,"VN"],[/indonesia|jakarta/i,"ID"],[/thailand|bangkok/i,"TH"],[/philippines|manila/i,"PH"],
  [/nigeria|lagos/i,"NG"],[/egypt|cairo/i,"EG"],[/south africa|cape town|johannesburg/i,"ZA"],[/kenya|nairobi/i,"KE"],
  [/new zealand|auckland/i,"NZ"],[/romania|bucharest/i,"RO"],[/hungary|budapest/i,"HU"],[/greece|athens/i,"GR"],[/pakistan|karachi|lahore/i,"PK"],[/bangladesh|dhaka/i,"BD"],
];
function locToCC(loc) { if (!loc) return null; for (const [re, cc] of LOC_CC) if (re.test(loc)) return cc; return null; }
async function resolveCountries(items) {
  const cache = new Map();
  if (existsSync(OUT)) {
    try { for (const it of JSON.parse(readFileSync(OUT, "utf8")).items || []) if (it.co && it.o) cache.set(it.src + ":" + it.o, it.co); } catch {}
  }
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "oss-times-portal" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  let fetched = 0, resolved = 0;
  const asked = new Set();
  for (const it of items) {
    if (!it.co && JA.test((it.n || "") + (it.d || ""))) it.co = "JP"; // 日本語の説明＝日本発とみなす
    if (it.co) { resolved++; continue; }
    const ck = it.src + ":" + it.o;
    if (cache.has(ck)) { it.co = cache.get(ck); resolved++; continue; }
    if (it.src === "gh" && it.o && !MOCK && fetched < 400 && !asked.has(it.o)) {
      asked.add(it.o);
      try {
        const u = await api(`https://api.github.com/users/${encodeURIComponent(it.o)}`, headers);
        const cc = locToCC(u.location || "");
        if (cc) { it.co = cc; cache.set(ck, cc); }
      } catch {}
      fetched++;
      await sleep(120);
    }
    if (!it.co && it.h) { const cc = tldCountry(it.h); if (cc) it.co = cc; }
    if (it.co) resolved++;
  }
  console.error(`国判定: ${resolved}/${items.length}件（owner照会${fetched}件）`);
}

/* ===== アーカイブ引き継ぎ（一度載せたものは保持し、死活監視でのみクローズ） ===== */
function mergePrev(results) {
  if (!existsSync(OUT)) return;
  let prev;
  try { prev = JSON.parse(readFileSync(OUT, "utf8")).items || []; } catch { return; }
  let kept = 0;
  for (const it of prev) {
    const key = it.src + "/" + it.f;
    if (results.has(key)) {
      const cur = results.get(key);
      cur.lc = it.lc; cur.miss = 0;
      if (!cur.co && it.co) cur.co = it.co;
      if (!cur.dj && it.dj && cur.d === it.d) cur.dj = it.dj;
      continue;
    }
    if (it.src === "own") continue; // 手動掲載は毎回 custom.json を正とする
    results.set(key, it); kept++;
  }
  if (kept) console.error(`アーカイブ引き継ぎ: ${kept}件（検索窓から外れても掲載継続）`);
}

/* ===== 死活監視（404/410が2回連続 → 非公開/削除としてクローズ） ===== */
async function pruneDead(items) {
  if (MOCK) return items;
  const now = Date.now();
  const cands = items.filter((i) => i.src !== "own" && (!i.lc || now - new Date(i.lc).getTime() > 3 * 864e5));
  cands.sort((a, b) => new Date(a.lc || 0) - new Date(b.lc || 0));
  const headers = { "User-Agent": "oss-times-portal", Accept: "application/vnd.github+json" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  let checked = 0;
  for (const it of cands.slice(0, 150)) {
    let gone = false, ok = false;
    try {
      if (it.src === "gh") {
        const r = await fetch(`https://api.github.com/repos/${it.f}`, { headers });
        gone = r.status === 404 || r.status === 451; ok = r.ok || r.status === 403 || r.status === 429;
      } else {
        const target = it.h || it.u;
        let r = await fetch(target, { method: "HEAD", redirect: "follow" });
        if (r.status === 405 || r.status === 501) r = await fetch(target, { method: "GET", redirect: "follow" });
        gone = r.status === 404 || r.status === 410;
        ok = r.ok || r.status === 403 || r.status === 429;
      }
    } catch { ok = true; } // ネットワーク一時障害はカウントしない
    it.lc = new Date().toISOString();
    if (gone) { it.miss = (it.miss || 0) + 1; if (it.miss >= 2) it.deadFlag = true; }
    else if (ok) it.miss = 0;
    checked++;
    await sleep(150);
  }
  const alive = items.filter((i) => !i.deadFlag);
  if (items.length - alive.length) console.error(`死活監視: ${checked}件確認 → ${items.length - alive.length}件をクローズ`);
  else console.error(`死活監視: ${checked}件確認（クローズなし）`);
  return alive;
}

/* ===== 日本語翻訳 ===== */
async function gtx(text) {
  const j = await api(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ja&dt=t&q=${encodeURIComponent(text)}`);
  return (j[0] || []).map((seg) => seg[0]).join("");
}
async function mymemory(text) {
  const j = await api(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|ja`);
  const t = j.responseData?.translatedText;
  if (!t || /MYMEMORY WARNING/i.test(t)) throw new Error("mymemory limit");
  return t;
}
async function translateAll(items) {
  const cache = new Map();
  if (existsSync(OUT)) {
    try { for (const it of JSON.parse(readFileSync(OUT, "utf8")).items || []) if (it.dj) cache.set(it.src + "/" + it.f + "|" + it.d, it.dj); } catch {}
  }
  let hit = 0, done = 0, fail = 0;
  for (const it of items) {
    const d = (it.d || "").trim();
    if (it.dj) continue;
    if (!d || d.length < 8) continue;
    if (JA.test(d)) { it.dj = d; continue; }
    const k = it.src + "/" + it.f + "|" + it.d;
    if (cache.has(k)) { it.dj = cache.get(k); hit++; continue; }
    if (MOCK) continue;
    const text = d.slice(0, 400);
    try { it.dj = await gtx(text); done++; }
    catch {
      await sleep(800);
      try { it.dj = await gtx(text); done++; }
      catch { try { it.dj = await mymemory(text); done++; } catch { fail++; } }
    }
    if ((done + fail) % 100 === 0 && done + fail > 0) console.error(`  翻訳進捗: ${done + fail}件`);
    await sleep(140);
  }
  console.error(`翻訳: キャッシュ${hit} / 新規${done} / 失敗${fail}`);
}

/* ===== 紹介記事の自動生成 ===== */
function templateArticle(it, items) {
  const born = Math.max(1, Math.floor(daysSince(it.c)));
  const vel = (it.s / Math.max(1, daysSince(it.c)));
  const desc = it.dj || it.d || "";
  const cat = (it.uc && it.uc[0]) || "注目";
  const p1 = `「${it.n}」は、${desc}${/[。.!?！？]$/.test(desc) ? "" : "。"}${SRCJP[it.src] || it.src}で公開から${born}日、すでに★${it.s.toLocaleString()}を獲得している${vel >= 5 ? "急成長中の" : ""}サービスだ。`;
  const tech = [it.l && `主要言語は${it.l}`, it.lic && `ライセンスは${it.lic}`, it.t && it.t.length ? `タグは ${it.t.slice(0, 4).join(", ")}` : null].filter(Boolean).join("。");
  const p2 = tech ? tech + "。" : null;
  const similar = items.filter((x) => x !== it && x.uc && it.uc && x.uc[0] === it.uc[0]).sort((a, b) => b.s - a.s).slice(0, 3).map((x) => x.n);
  const p3 = `${it.h ? "公式サイト/デモが用意されており、リンクからすぐに試せる。" : "詳細はリポジトリ/投稿ページから確認できる。"}${similar.length ? `同じ「${cat}」分野では ${similar.join("、")} なども掲載中。比較して選びたい。` : ""}`;
  return { title: `【${cat}】${it.n} — 公開${born}日で★${it.s.toLocaleString()}`, body: [p1, p2, p3].filter(Boolean) };
}
async function groqArticle(it) {
  const facts = { name: it.n, desc: it.dj || it.d, source: SRCJP[it.src], stars: it.s, days: Math.max(1, Math.floor(daysSince(it.c))), lang: it.l, license: it.lic, tags: it.t, usecase: it.uc };
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", headers: { Authorization: "Bearer " + GROQ, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "llama-3.3-70b-versatile", temperature: 0.4, max_tokens: 700, response_format: { type: "json_object" },
      messages: [
        { role: "system", content: 'OSS紹介メディアの編集者。与えられた事実のみを使い、日本語で魅力的な紹介記事を書く。誇張・創作は禁止。JSONのみ返す: {"title":"30字以内","body":["段落1","段落2","段落3"]}' },
        { role: "user", content: JSON.stringify(facts) },
      ] }),
  });
  if (!res.ok) throw new Error("groq " + res.status);
  const j = await res.json();
  const parsed = JSON.parse(j.choices[0].message.content);
  if (!parsed.title || !Array.isArray(parsed.body)) throw new Error("groq bad json");
  return parsed;
}
async function makeArticles(items) {
  let prev = [];
  try { prev = JSON.parse(readFileSync(ART, "utf8")).articles || []; } catch {}
  const covered = new Set(prev.map((a) => a.key));
  const pool = items
    .filter((i) => daysSince(i.c) <= 45 && i.s >= 25 && !covered.has(i.src + "/" + i.f) && (i.dj || i.d))
    .sort((a, b) => b.s / Math.max(1, daysSince(b.c)) - a.s / Math.max(1, daysSince(a.c)))
    .slice(0, 40); // 上位40からランダムに3本（毎回顔ぶれが変わる）
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const cands = pool.slice(0, 3);
  const fresh = [];
  for (const it of cands) {
    let art = null, llm = false;
    if (GROQ && !MOCK) { try { art = await groqArticle(it); llm = true; await sleep(1200); } catch (e) { console.error("  groq記事失敗: " + e.message); } }
    if (!art) art = templateArticle(it, items);
    fresh.push({ key: it.src + "/" + it.f, f: it.f, src: it.src, date: new Date().toISOString(), llm, ...art });
  }
  const articles = [...fresh, ...prev].slice(0, 60);
  writeFileSync(ART, JSON.stringify({ articles }));
  console.error(`記事: 新規${fresh.length}件（累計${articles.length}件）${GROQ ? " [LLM]" : " [テンプレート]"}`);
}

/* ===== Google Safe Browsing（任意・SAFE_BROWSING_API_KEY設定時のみ） ===== */
async function safeBrowsingCheck(items) {
  const bad = new Set();
  if (!SB_KEY || MOCK) return bad;
  const urls = [...new Set(items.filter((i) => i.h).map((i) => i.h))].slice(0, 500);
  try {
    const res = await fetch("https://safebrowsing.googleapis.com/v4/threatMatches:find?key=" + SB_KEY, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client: { clientId: "oss-times", clientVersion: "1.0" },
        threatInfo: {
          threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"],
          platformTypes: ["ANY_PLATFORM"], threatEntryTypes: ["URL"],
          threatEntries: urls.map((u) => ({ url: u })),
        },
      }),
    });
    if (!res.ok) throw new Error("sb " + res.status);
    for (const m of (await res.json()).matches || []) if (m.threat?.url) bad.add(m.threat.url);
    if (bad.size) console.error(`SafeBrowsing: 危険URL ${bad.size}件を除外`);
  } catch (e) { console.error("SafeBrowsing失敗（スキップ）: " + e.message); }
  return bad;
}

/* ===== メイン ===== */
async function main() {
  const results = new Map();
  await fetchGitHub(results);
  await fetchGitHubJapan(results);
  await fetchGitLab(results);
  await fetchCodeberg(results);
  await fetchHuggingFace(results);
  await fetchHackerNews(results);
  await fetchReddit(results);
  await fetchDevto(results);
  await fetchBluesky(results);
  await fetchQiita(results);
  await fetchZenn(results);
  mergeCustom(results);
  mergePrev(results);

  let items = [...results.values()].sort((a, b) => b.s - a.s);
  if (items.length > 3000) items = items.slice(0, 3000); // アーカイブ上限
  for (const it of items) if (!it.uc) it.uc = ucOf(it.n, it.t, it.d);
  await resolveCountries(items);
  await translateAll(items);
  const bad = await safeBrowsingCheck(items);
  if (bad.size) items = items.filter((i) => !(i.h && bad.has(i.h)));
  items = await pruneDead(items);
  mkdirSync(dirname(OUT), { recursive: true });
  await makeArticles(items);

  const data = {
    meta: {
      generatedAt: new Date().toISOString(),
      count: items.length,
      categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label })),
      sources: SRCJP,
      ...(MOCK ? { seed: true } : {}),
    },
    items,
  };
  writeFileSync(OUT, JSON.stringify(data));
  console.error(`書き込み完了: ${OUT} (${items.length}件)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
