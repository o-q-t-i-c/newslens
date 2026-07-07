// NewsLens 収集スクリプト v3
// - 媒体(OUTLETS)とフィード(FEEDS)を分離。カテゴリ別RSSを持つ媒体は複数フィードを登録
// - カテゴリRSSが無い媒体はキーワードで自動分類
// - RSS内の画像(media:thumbnail / enclosure / description内img)を抽出
// - トピックごとに「どの媒体が報じたか」を集計(未掲載媒体の可視化はUI側で行う)
// 運営コスト:ゼロ(GitHub Actions + GitHub Pages 無料枠のみ)

import { writeFileSync, readFileSync, existsSync } from "node:fs";

// ============================================================
// 媒体の定義
// group: "press" = 新聞・通信・放送 / "web" = ウェブメディア
// domain はファビコン表示に使う
// ============================================================
const OUTLETS = [
  { id: "nhk",      name: "NHK",             group: "press", domain: "www3.nhk.or.jp" },
  { id: "asahi",    name: "朝日新聞",         group: "press", domain: "www.asahi.com" },
  { id: "yomiuri",  name: "読売新聞",         group: "press", domain: "www.yomiuri.co.jp" },
  { id: "sankei",   name: "産経新聞",         group: "press", domain: "www.sankei.com" },
  { id: "mainichi", name: "毎日新聞",         group: "press", domain: "mainichi.jp" },
  { id: "jiji",     name: "時事通信",         group: "press", domain: "www.jiji.com" },
  { id: "huffpost", name: "ハフポスト",       group: "web",   domain: "www.huffingtonpost.jp" },
  { id: "bengoshi", name: "弁護士ドットコム", group: "web",   domain: "www.bengo4.com" },
  { id: "buzzfeed", name: "BuzzFeed Japan",  group: "web",   domain: "www.buzzfeed.com" },
  { id: "gigazine", name: "GIGAZINE",        group: "web",   domain: "gigazine.net" },
  { id: "itmedia",  name: "ITmedia",         group: "web",   domain: "www.itmedia.co.jp" },
];

// ============================================================
// フィードの定義
// cat を指定したフィードの記事はそのカテゴリに確定。
// cat: null のフィードはタイトルのキーワードで自動分類する。
// カテゴリ: politics / economy / world / society / tech / sports / other
// ============================================================
const FEEDS = [
  // NHK はカテゴリ別RSSが充実しているのでフル活用
  { outlet: "nhk", cat: "politics", url: "https://www3.nhk.or.jp/rss/news/cat4.xml" },
  { outlet: "nhk", cat: "economy",  url: "https://www3.nhk.or.jp/rss/news/cat5.xml" },
  { outlet: "nhk", cat: "world",    url: "https://www3.nhk.or.jp/rss/news/cat6.xml" },
  { outlet: "nhk", cat: "society",  url: "https://www3.nhk.or.jp/rss/news/cat1.xml" },
  { outlet: "nhk", cat: "tech",     url: "https://www3.nhk.or.jp/rss/news/cat3.xml" },
  { outlet: "nhk", cat: "sports",   url: "https://www3.nhk.or.jp/rss/news/cat7.xml" },
  // 総合フィード(キーワードで自動分類)
  { outlet: "asahi",    cat: null, url: "https://www.asahi.com/rss/asahi/newsheadlines.rdf" },
  { outlet: "yomiuri",  cat: null, url: "https://assets.wor.jp/rss/rdf/yomiuri/topstories.rdf" },
  { outlet: "sankei",   cat: null, url: "https://assets.wor.jp/rss/rdf/sankei/flash.rdf" },
  { outlet: "mainichi", cat: null, url: "https://mainichi.jp/rss/etc/mainichi-flash.rss" },
  { outlet: "jiji",     cat: null, url: "https://www.jiji.com/rss/ranking.rdf" },
  { outlet: "huffpost", cat: null, url: "https://www.huffingtonpost.jp/feeds/index.xml" },
  { outlet: "bengoshi", cat: null, url: "https://www.bengo4.com/topics/rss/index.xml" },
  { outlet: "buzzfeed", cat: null, url: "https://www.buzzfeed.com/jp.xml" },
  { outlet: "gigazine", cat: null, url: "https://gigazine.net/news/rss_2.0/" },
  { outlet: "itmedia",  cat: null, url: "https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml" },
];

const MAX_AGE_HOURS = 48;
const SIMILARITY_THRESHOLD = 0.20; // 実測: MERGE最小0.13 / SPLIT最大0.07(v2で計測)
const DATA_PATH = new URL("../docs/data.json", import.meta.url);

// ============================================================
// キーワードによるカテゴリ自動分類(カテゴリRSSが無い媒体用)
// 上から順に判定し、最初に当たったカテゴリになる。
// ============================================================
const CATEGORY_RULES = [
  ["sports",   /野球|サッカー|Jリーグ|大リーグ|MLB|NBA|五輪|オリンピック|パラリンピック|選手権|W杯|ワールドカップ|大相撲|ゴルフ|テニス|駅伝|マラソン|プロ野球|甲子園|フィギュア/],
  ["politics", /首相|内閣|政権|国会|衆院|参院|選挙|政党|自民|立憲|公明|維新|共産|大臣|官房|法案|閣議|知事選|市長選|子育て支援|少子化|防衛費|憲法/],
  ["economy",  /日銀|株価|株式|円安|円高|為替|金利|利上げ|利下げ|物価|賃金|賃上げ|GDP|景気|貿易|関税|決算|上場|倒産|投資|税制|年金|値上げ|インフレ/],
  ["world",    /米国|アメリカ|中国|韓国|北朝鮮|ロシア|ウクライナ|イスラエル|パレスチナ|ガザ|EU|国連|大統領|外相|外交|首脳|台湾|NATO|トランプ|中東/],
  ["tech",     /\bAI\b|人工知能|半導体|スマホ|iPhone|アプリ|グーグル|Google|アップル|Apple|メタ|SNS|アルゴリズム|サイバー|宇宙|ロケット|研究チーム|ノーベル|量子|生成AI|チャットGPT|ChatGPT/i],
  ["society",  /事件|事故|裁判|判決|逮捕|容疑|災害|地震|台風|豪雨|大雨|線状降水帯|猛暑|熱中症|噴火|火災|警察|検察|学校|いじめ|感染|医療|介護|保育/],
];

function classify(title) {
  for (const [cat, re] of CATEGORY_RULES) if (re.test(title)) return cat;
  return "other";
}

// ============================================================
// RSS / Atom 簡易パーサ(画像抽出つき)
// ============================================================
function parseFeed(xml, feed) {
  const outlet = OUTLETS.find((o) => o.id === feed.outlet);
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

    // 画像:media:thumbnail → enclosure → 本文内<img> の順で探す
    let image = "";
    let m = block.match(/<media:thumbnail[^>]*url="([^"]+)"/) ||
            block.match(/<media:content[^>]*url="([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i) ||
            block.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image\/[^"]*"/) ||
            block.match(/<enclosure[^>]*type="image\/[^"]*"[^>]*url="([^"]+)"/) ||
            block.match(/<img[^>]*src=["']?(https?:\/\/[^"'\s>]+)/i);
    if (m) image = m[1].replace(/&amp;/g, "&");

    items.push({
      title,
      url: link.trim(),
      publishedAt: new Date(ts).toISOString(),
      outletId: outlet.id,
      outletName: outlet.name,
      group: outlet.group,
      cat: feed.cat || classify(title),
      image,
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
// クラスタリング(文字バイグラムoverlap係数 + 単一リンク法)
// 注: IDF重み付けは実験の結果、逆効果と判明(同一事件の記事群では
// トピック語が繰り返されるため、IDFがその信号を減衰させる)
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
  return inter / Math.min(a.size, b.size);
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

    // 媒体ごとにまとめる(同一媒体の続報は代表1本+残りを束ねる)
    const byOutlet = new Map();
    for (const a of arts) {
      if (!byOutlet.has(a.outletId)) byOutlet.set(a.outletId, []);
      byOutlet.get(a.outletId).push(a);
    }
    const outlets = [...byOutlet.entries()].map(([outletId, list]) => ({
      outletId,
      outletName: list[0].outletName,
      group: list[0].group,
      articles: list.map(({ title, url, publishedAt }) => ({ title, url, publishedAt })),
    }));

    // カテゴリ:記事の多数決(同数なら新しい記事優先)
    const catCount = new Map();
    for (const a of arts) catCount.set(a.cat, (catCount.get(a.cat) || 0) + 1);
    const cat = [...catCount.entries()].sort((x, y) => y[1] - x[1])[0][0];

    // 画像:いちばん新しい記事の画像を採用
    const image = (arts.find((a) => a.image) || {}).image || "";

    return {
      topic: arts[0].title,
      updatedAt: arts[0].publishedAt,
      cat,
      image,
      outletCount: outlets.length,
      articleCount: arts.length,
      outlets,
    };
  });
}

// ============================================================
// メイン
// ============================================================
async function fetchFeed(feed) {
  const outlet = OUTLETS.find((o) => o.id === feed.outlet);
  try {
    const res = await fetch(feed.url, {
      headers: { "User-Agent": "NewsLensBot/0.3 (prototype)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = parseFeed(await res.text(), feed);
    console.log(`✓ ${outlet.name}${feed.cat ? `(${feed.cat})` : ""}: ${items.length}件`);
    return items;
  } catch (e) {
    console.error(`✗ ${outlet.name}${feed.cat ? `(${feed.cat})` : ""}: ${e.message}`);
    return []; // 1フィードの失敗で全体を止めない
  }
}

async function main() {
  const useSample = process.argv.includes("--sample");
  let fresh = [];

  if (useSample) {
    for (const feed of FEEDS) {
      try {
        const xml = readFileSync(new URL(`../sample-feeds/${feed.outlet}.xml`, import.meta.url), "utf8");
        fresh.push(...parseFeed(xml, { ...feed, cat: null }));
      } catch { /* サンプルの無い媒体はスキップ */ }
    }
    // 同一媒体の複数フィードでサンプルを二重に読まないよう重複除去はこの後の処理に任せる
  } else {
    fresh = (await Promise.all(FEEDS.map(fetchFeed))).flat();
  }

  // 前回データとマージ(RSSから消えた記事も48時間は保持)
  let previous = [];
  if (existsSync(DATA_PATH)) {
    try {
      const old = JSON.parse(readFileSync(DATA_PATH, "utf8"));
      for (const t of old.topics || []) {
        for (const o of t.outlets || []) {
          for (const a of o.articles || []) {
            previous.push({
              title: a.title, url: a.url, publishedAt: a.publishedAt,
              outletId: o.outletId, outletName: o.outletName, group: o.group,
              cat: t.cat, image: t.image || "",
            });
          }
        }
      }
    } catch { /* 壊れていたら無視 */ }
  }

  const validOutletIds = new Set(OUTLETS.map((o) => o.id));
  const cutoff = Date.now() - MAX_AGE_HOURS * 3600 * 1000;
  const seen = new Set();
  const all = [...fresh, ...previous].filter((it) => {
    if (!it?.url || !it?.title) return false;
    if (!validOutletIds.has(it.outletId)) return false;
    if (Date.parse(it.publishedAt) < cutoff) return false;
    if (seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });

  const topics = cluster(all).sort((a, b) =>
    b.outletCount - a.outletCount || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  const output = {
    generatedAt: new Date().toISOString(),
    outlets: OUTLETS,
    topics,
  };

  writeFileSync(DATA_PATH, JSON.stringify(output));
  const multi = topics.filter((t) => t.outletCount > 1).length;
  console.log(`\n記事 ${all.length}件 → ${topics.length}トピック(複数媒体: ${multi})`);
}

main();
