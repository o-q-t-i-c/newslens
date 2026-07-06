// NewsLens 収集スクリプト v2
// - 各社RSSから記事を取得(依存ライブラリなし、Node 18+)
// - 前回の data.json とマージして48時間分を蓄積
// - IDF重み付きバイグラム類似度で同一トピックを自動クラスタリング
// - 「独立系のみ / 既成のみ / 両サイド」を自動分類(ブラインドスポット検出)
// 運営コスト:ゼロ(GitHub Actions + GitHub Pages 無料枠のみで動作)

import { writeFileSync, readFileSync, existsSync } from "node:fs";

// ============================================================
// 収集元
// camp: "est" = 既成メディア / "indie" = 独立系Webメディア
// RSSのURLは変わることがある。動かない媒体はログに✗が出るので、ここを直す。
// ============================================================
const SOURCES = [
  // --- 既成メディア ---
  { id: "nhk",      name: "NHK",             camp: "est",   url: "https://www3.nhk.or.jp/rss/news/cat0.xml" },
  { id: "asahi",    name: "朝日新聞",         camp: "est",   url: "https://www.asahi.com/rss/asahi/newsheadlines.rdf" },
  { id: "yomiuri",  name: "読売新聞",         camp: "est",   url: "https://assets.wor.jp/rss/rdf/yomiuri/topstories.rdf" },
  { id: "sankei",   name: "産経新聞",         camp: "est",   url: "https://assets.wor.jp/rss/rdf/sankei/flash.rdf" },
  { id: "mainichi", name: "毎日新聞",         camp: "est",   url: "https://mainichi.jp/rss/etc/mainichi-flash.rss" },
  { id: "jiji",     name: "時事通信",         camp: "est",   url: "https://www.jiji.com/rss/ranking.rdf" },
  // --- 独立系Webメディア ---
  { id: "huffpost", name: "ハフポスト",       camp: "indie", url: "https://www.huffingtonpost.jp/feeds/index.xml" },
  { id: "bengoshi", name: "弁護士ドットコム", camp: "indie", url: "https://www.bengo4.com/topics/rss/index.xml" },
  { id: "buzzfeed", name: "BuzzFeed Japan",  camp: "indie", url: "https://www.buzzfeed.com/jp.xml" },
  { id: "gigazine", name: "GIGAZINE",        camp: "indie", url: "https://gigazine.net/news/rss_2.0/" },
  { id: "itmedia",  name: "ITmedia",         camp: "indie", url: "https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml" },
];

const MAX_AGE_HOURS = 48;          // 保持する記事の新しさ
const SIMILARITY_THRESHOLD = 0.20; // 類似度の閾値(上げる=厳密、下げる=緩い)。実測でMERGE最小0.13/SPLIT最大0.07
const DATA_PATH = new URL("../docs/data.json", import.meta.url);

// ============================================================
// RSS / Atom 簡易パーサ
// ============================================================
function parseFeed(xml, source) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/g) || [];
  for (const block of blocks) {
    const pick = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return m ? decode(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim()) : "";
    };
    let link = pick("link");
    if (!link) {
      const m = block.match(/<link[^>]*href="([^"]+)"/);
      link = m ? m[1] : "";
    }
    const title = pick("title");
    const date = pick("pubDate") || pick("dc:date") || pick("updated") || pick("published");
    if (!title || !link) continue;
    const ts = date ? Date.parse(date) : Date.now();
    if (Number.isNaN(ts)) continue;
    items.push({
      title,
      url: link.trim(),
      publishedAt: new Date(ts).toISOString(),
      sourceId: source.id,
      sourceName: source.name,
      camp: source.camp,
    });
  }
  return items;
}

function decode(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, "").trim();
}

// ============================================================
// クラスタリング(文字バイグラムのoverlap係数 + 単一リンク法)
// 注:IDF重み付けは試したが逆効果だった。同一事件の記事群では
// トピック語(「日銀」「利上げ」等)こそが繰り返し現れるため、
// IDFがその信号を減衰させてしまう。素のoverlapが最も安定。
// ============================================================
function bigrams(text) {
  const t = text.replace(/[\s、。「」『』【】()()\[\]・:;:!?!?…|/／-]/g, "");
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function similarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / Math.min(a.size, b.size); // overlap係数(短いタイトルでも拾える)
}

function cluster(items) {
  const grams = items.map((it) => bigrams(it.title));
  const clusters = [];
  const assigned = new Array(items.length).fill(-1);

  for (let i = 0; i < items.length; i++) {
    if (assigned[i] !== -1) continue;
    const members = [i];
    assigned[i] = clusters.length;
    for (let j = i + 1; j < items.length; j++) {
      if (assigned[j] !== -1) continue;
      if (members.some((m) => similarity(grams[m], grams[j]) >= SIMILARITY_THRESHOLD)) {
        members.push(j);
        assigned[j] = clusters.length;
      }
    }
    clusters.push(members);
  }

  return clusters.map((members) => {
    const arts = members.map((m) => items[m])
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
    const estCount = arts.filter((a) => a.camp === "est").length;
    const indieCount = arts.filter((a) => a.camp === "indie").length;
    const sourceCount = new Set(arts.map((a) => a.sourceId)).size;
    // 分類:both = 両サイドが報道 / indieOnly / estOnly
    const coverage = estCount > 0 && indieCount > 0 ? "both"
                   : indieCount > 0 ? "indieOnly" : "estOnly";
    return {
      topic: arts[0].title,
      updatedAt: arts[0].publishedAt,
      sourceCount, estCount, indieCount, coverage,
      articles: arts,
    };
  });
}

// ============================================================
// メイン
// ============================================================
async function fetchSource(source) {
  try {
    const res = await fetch(source.url, {
      headers: { "User-Agent": "NewsLensBot/0.2 (prototype)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = parseFeed(await res.text(), source);
    console.log(`✓ ${source.name}: ${items.length}件`);
    return items;
  } catch (e) {
    console.error(`✗ ${source.name}: ${e.message}`); // 1媒体の失敗で全体を止めない
    return [];
  }
}

async function main() {
  const useSample = process.argv.includes("--sample");
  let fresh = [];

  if (useSample) {
    for (const s of SOURCES) {
      try {
        const xml = readFileSync(new URL(`../sample-feeds/${s.id}.xml`, import.meta.url), "utf8");
        fresh.push(...parseFeed(xml, s));
      } catch { /* サンプルの無い媒体はスキップ */ }
    }
  } else {
    fresh = (await Promise.all(SOURCES.map(fetchSource))).flat();
  }

  // 前回データとマージ(RSSから消えた記事も48時間は保持し続ける)
  let previous = [];
  if (existsSync(DATA_PATH)) {
    try {
      const old = JSON.parse(readFileSync(DATA_PATH, "utf8"));
      previous = (old.topics || []).flatMap((t) => t.articles || []);
    } catch { /* 壊れていたら無視して新規作成 */ }
  }

  const validSourceIds = new Set(SOURCES.map((s) => s.id));
  const cutoff = Date.now() - MAX_AGE_HOURS * 3600 * 1000;
  const seen = new Set();
  const all = [...fresh, ...previous].filter((it) => {
    if (!it?.url || !it?.title) return false;
    if (!validSourceIds.has(it.sourceId)) return false;      // 削除した媒体を排除
    if (Date.parse(it.publishedAt) < cutoff) return false;    // 古い記事を排除
    if (seen.has(it.url)) return false;                       // URL重複を排除
    seen.add(it.url);
    return true;
  });

  const topics = cluster(all).sort((a, b) =>
    b.sourceCount - a.sourceCount || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  const output = {
    generatedAt: new Date().toISOString(),
    sources: SOURCES.map(({ id, name, camp }) => ({ id, name, camp })),
    stats: {
      articles: all.length,
      topics: topics.length,
      both: topics.filter((t) => t.coverage === "both").length,
      indieOnly: topics.filter((t) => t.coverage === "indieOnly").length,
      estOnly: topics.filter((t) => t.coverage === "estOnly").length,
    },
    topics,
  };

  writeFileSync(DATA_PATH, JSON.stringify(output));
  console.log(`\n記事 ${all.length}件 → ${topics.length}トピック ` +
    `(両サイド: ${output.stats.both} / 独立系のみ: ${output.stats.indieOnly} / 既成のみ: ${output.stats.estOnly})`);
}

main();
