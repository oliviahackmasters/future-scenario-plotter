/**
 * scenario-assessment.js  (updated)
 *
 * Changes from original:
 *  1. isBlockedOrBrokenSource() — Reuters/CNN no longer hardblocked;
 *     user-added sources ALWAYS bypass the block list.
 *  2. fetchNewsApiArticles() — parallel data source via NewsAPI.org.
 *  3. fetchWorldMonitorArticles() — polls the standalone scraper service.
 *  4. dedupeByTitle() — title similarity dedup chained after URL dedup.
 *  5. Article limits raised: MAX_ARTICLES_FOR_MODEL 3→5, MAX_FILTERED_ITEMS 5→8.
 *  6. TOPICS now topic-agnostic with pluggable configs; Iran is one preset.
 *  7. collectTopicCoverage() merges RSS + NewsAPI + WorldMonitor.
 */

import Parser from "rss-parser";
import OpenAI from "openai";
import {
  loadAssessmentHistory,
  saveAssessmentHistory,
  saveLatestAssessment
} from "../lib/blob-store.js";
import { getMergedSavedSources } from "../lib/source-store.js";
import { discoverFeedFromWebsite } from "../lib/feed-discovery.js";

const parser = new Parser();

// ── Constants ──────────────────────────────────────────────────────────────────

const RSS_FETCH_TIMEOUT_MS        = 3500;
const JSON_FETCH_TIMEOUT_MS       = 8000;
const OPENAI_TIMEOUT_FALLBACK_MS  = 15000;
const MAX_ITEMS_PER_FEED          = 8;   // was 6
const MAX_ARTICLES_FOR_MODEL      = 5;   // was 3
const MAX_FILTERED_ITEMS          = 8;   // was 5
const MIN_MATCHES_REQUIRED        = 2;

// ── Topic Configurations ───────────────────────────────────────────────────────
// Each topic is a self-contained config. Add new topics here as the tool grows.
// The "scenario" field in the UI maps to the key (e.g. "iran", "defence", "health").

const TOPICS = {
  iran: {
    label: "Iran",
    newsApiQuery: "Iran OR Hormuz OR Tehran OR IRGC OR Gulf",
    scenarios: [
      {
        name: "Chaos + Collapse",
        description: "Multi-state regional war and a dysfunctional government in Iran.",
        gccReality: "Extreme security volatility, refugee flows, cross-border instability, oil system shock, and global recession risk.",
        scenarioSignals: ["loss of central command in Iran", "multiple armed factions emerge", "war spills across Iraq, Lebanon, and the Gulf simultaneously"]
      },
      {
        name: "Shattered Diplomacy",
        description: "Security threat reduces in the short term, but long-term uncertainty rises through ungoverned spaces in Iran and militia proliferation.",
        gccReality: "Security threat reduces short term but long-term uncertainty rises through ungoverned spaces in Iran and militias.",
        scenarioSignals: ["leadership fractures", "internal uprising or regime weakening", "reduced coordination of external attacks"]
      },
      {
        name: "Burning Strait",
        description: "The Gulf becomes an active war theatre, with severe energy-export disruption and mounting internal stability pressure.",
        gccReality: "Active war theatre, energy exports severely disrupted, civil defence activation, and internal stability pressures.",
        scenarioSignals: ["long-term Hormuz closure", "direct GCC military retaliation", "large-scale infrastructure strikes"]
      },
      {
        name: "Cold Containment",
        description: "Managed escalation with constant security pressure, rising defence costs, and disrupted but still functioning oil flows.",
        gccReality: "Constant security pressure, rising defence costs, economic resilience but slow growth.",
        scenarioSignals: ["repeated ceasefire attempts", "limited symbolic retaliation", "oil flows disrupted but not halted"]
      }
    ],
    trackedSignals: [
      "oil prices", "oil flows", "troop deployment", "government stability",
      "leadership fractures", "central command cohesion", "diplomacy / ceasefire",
      "maritime disruption", "infrastructure strikes", "protests / internal uprising",
      "external attack coordination", "armed faction emergence", "regional spillover",
      "prediction market odds"
    ],
    sources: [
      { name: "BBC Middle East",   url: "http://feeds.bbci.co.uk/news/world/middle_east/rss.xml" },
      { name: "FT Oil",            url: "https://www.ft.com/oil?format=rss" },
      { name: "Al Jazeera",        url: "https://www.aljazeera.com/xml/rss/all.xml" },
      { name: "FT Energy",         url: "https://www.ft.com/energy?format=rss" },
      { name: "Guardian World",    url: "https://www.theguardian.com/world/rss" },
      { name: "Tehran Times",      url: "https://www.tehrantimes.com/rss" },
      { name: "Middle East Eye",   url: "https://www.middleeasteye.net/rss" }
    ],
    keywordFilter: [
      "iran", "tehran", "iranian", "strait of hormuz", "hormuz", "gulf", "gcc",
      "israel", "iraq", "lebanon", "militia", "militias", "troops", "oil", "energy",
      "refugee", "ceasefire", "retaliation", "infrastructure", "airstrike", "missile",
      "uprising", "leadership", "regime", "command", "factions", "shipping",
      "sanctions", "strike", "drone", "attack", "naval", "seizure", "port",
      "explosion", "power plant", "tankers", "kharg", "irgc", "pasdaran"
    ],
    polymarketSearchTerms: ["iran", "hormuz", "middle east war", "israel iran"]
  },

  defence: {
    label: "Defence & Security",
    newsApiQuery: "defence OR defense OR military OR NATO OR weapons OR conflict",
    scenarios: [
      {
        name: "Escalation",
        description: "Active armed conflict or significant military build-up with cross-border implications.",
        gccReality: "Direct military engagement, alliance activation, supply chain disruptions.",
        scenarioSignals: ["active combat operations", "NATO Article 5 invoked", "mass troop mobilisation"]
      },
      {
        name: "Cold Standoff",
        description: "Persistent military posturing without direct kinetic exchange.",
        gccReality: "Elevated defence spending, arms race dynamics, frozen diplomacy.",
        scenarioSignals: ["increased military exercises", "arms sales accelerate", "no diplomatic progress"]
      },
      {
        name: "Diplomatic Resolution",
        description: "Negotiated de-escalation with ceasefire or treaty outcome.",
        gccReality: "Reduced operational tempo, peace dividend, reconstruction investment.",
        scenarioSignals: ["ceasefire talks", "UN mediation", "troop withdrawal begins"]
      },
      {
        name: "Proxy War",
        description: "Major powers support opposing sides through proxies without direct confrontation.",
        gccReality: "Sustained low-level conflict, humanitarian crisis, regional destabilisation.",
        scenarioSignals: ["proxy forces equipped", "foreign fighters arrive", "third-party weapons supply"]
      }
    ],
    trackedSignals: [
      "troop movements", "weapons transfers", "alliance activity", "ceasefire talks",
      "civilian casualties", "sanctions", "air defence", "naval posture", "cyber operations"
    ],
    sources: [
      { name: "BBC World",        url: "http://feeds.bbci.co.uk/news/world/rss.xml" },
      { name: "Defense News",     url: "https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml" },
      { name: "War on the Rocks", url: "https://warontherocks.com/feed/" },
      { name: "Breaking Defense", url: "https://breakingdefense.com/feed/" },
      { name: "Reuters World",    url: "https://feeds.reuters.com/reuters/worldNews" },
      { name: "Guardian World",   url: "https://www.theguardian.com/world/rss" }
    ],
    keywordFilter: [
      "military", "defence", "defense", "nato", "troops", "weapons", "missiles",
      "combat", "air force", "navy", "army", "conflict", "war", "ceasefire",
      "sanctions", "proxy", "alliance", "strike", "drone", "cyber", "intelligence"
    ],
    polymarketSearchTerms: ["nato", "war", "military conflict", "ukraine", "taiwan"]
  },

  health: {
    label: "Global Health",
    newsApiQuery: "pandemic OR outbreak OR WHO OR pathogen OR epidemic OR vaccine",
    scenarios: [
      {
        name: "Contained Outbreak",
        description: "Localised disease event managed without global spread.",
        gccReality: "Regional healthcare strain, limited travel disruption.",
        scenarioSignals: ["WHO declares PHEIC", "localised quarantine measures", "contact tracing effective"]
      },
      {
        name: "Global Pandemic",
        description: "Widespread international transmission with health system overload.",
        gccReality: "Borders close, supply chains disrupted, global recession risk.",
        scenarioSignals: ["WHO pandemic declaration", "multiple continents affected", "health system collapse"]
      },
      {
        name: "Vaccine Breakthrough",
        description: "Effective prophylactic deployed at scale, accelerating recovery.",
        gccReality: "Gradual normalisation, economic recovery, residual immunity gaps.",
        scenarioSignals: ["Phase 3 trial success", "emergency use authorisation", "mass vaccination rollout"]
      },
      {
        name: "Endemic Adaptation",
        description: "Pathogen becomes endemic; society adapts without elimination.",
        gccReality: "Ongoing background burden, periodic surges, long-term health costs.",
        scenarioSignals: ["seasonal wave patterns", "reduced severity", "population immunity plateau"]
      }
    ],
    trackedSignals: [
      "case counts", "hospitalisations", "WHO alerts", "vaccine efficacy",
      "travel restrictions", "border closures", "drug resistance", "mortality rate"
    ],
    sources: [
      { name: "WHO News",    url: "https://www.who.int/rss-feeds/news-english.xml" },
      { name: "STAT News",   url: "https://www.statnews.com/feed/" },
      { name: "BBC Health",  url: "http://feeds.bbci.co.uk/news/health/rss.xml" },
      { name: "Reuters Health", url: "https://feeds.reuters.com/reuters/healthNews" },
      { name: "Guardian Health", url: "https://www.theguardian.com/society/health/rss" }
    ],
    keywordFilter: [
      "pandemic", "outbreak", "vaccine", "virus", "pathogen", "who", "epidemic",
      "quarantine", "hospitalisations", "mortality", "transmission", "variant",
      "mutation", "public health", "cdc", "ppe", "lockdown", "immunity"
    ],
    polymarketSearchTerms: ["pandemic", "outbreak", "vaccine", "who"]
  },

  energy: {
    label: "Energy Markets",
    newsApiQuery: "oil price OR gas supply OR OPEC OR energy crisis OR LNG",
    scenarios: [
      {
        name: "Supply Shock",
        description: "Major supply disruption drives price spikes and energy security crisis.",
        gccReality: "Rationing, industrial shutdowns, political instability in import-dependent states.",
        scenarioSignals: ["major pipeline attack", "OPEC+ deep cuts", "key export terminal closed"]
      },
      {
        name: "Oversupply Glut",
        description: "Excess supply drives prices down, straining producer economies.",
        gccReality: "Petrostates face budget pressure, investment contraction, social unrest risk.",
        scenarioSignals: ["US shale surge", "OPEC quota breach", "demand collapse"]
      },
      {
        name: "Managed Transition",
        description: "Orderly shift to renewables with stable fossil fuel pricing.",
        gccReality: "Gradual investment pivot, moderate prices, policy-driven demand management.",
        scenarioSignals: ["IEA net-zero targets met", "renewable capacity growth on track", "carbon pricing expands"]
      },
      {
        name: "Price Volatility",
        description: "Wild price swings driven by geopolitics, speculation, and mixed signals.",
        gccReality: "Business uncertainty, delayed investment, consumer price instability.",
        scenarioSignals: ["futures curve inversion", "geopolitical premium spikes", "SPR releases"]
      }
    ],
    trackedSignals: [
      "Brent crude price", "gas spot price", "OPEC output", "US rig count",
      "LNG tanker rates", "refinery capacity", "pipeline status", "strategic reserves"
    ],
    sources: [
      { name: "FT Energy",       url: "https://www.ft.com/energy?format=rss" },
      { name: "FT Oil",          url: "https://www.ft.com/oil?format=rss" },
      { name: "Oilprice.com",    url: "https://oilprice.com/rss/main" },
      { name: "Reuters Energy",  url: "https://feeds.reuters.com/reuters/USenergyNews" },
      { name: "Guardian Environment", url: "https://www.theguardian.com/environment/rss" }
    ],
    keywordFilter: [
      "oil", "gas", "brent", "wti", "opec", "lng", "pipeline", "refinery",
      "energy", "fuel", "petrol", "diesel", "renewable", "solar", "wind",
      "carbon", "emissions", "iea", "barrels", "tanker", "storage", "crack spread"
    ],
    polymarketSearchTerms: ["oil price", "opec", "energy crisis", "gas price"]
  }
};

// ── Topic helpers ──────────────────────────────────────────────────────────────

export function getTopicConfig(topic) {
  const key = String(topic || "iran").toLowerCase().trim();
  return TOPICS[key] || TOPICS.iran;
}

export function listAvailableTopics() {
  return Object.entries(TOPICS).map(([key, config]) => ({
    key,
    label: config.label
  }));
}

// ── History (Blob) ─────────────────────────────────────────────────────────────

// function getHistoryBlobPath(topic) {
//   return `history/${String(topic || "iran").toLowerCase()}.json`;
// }

// async function readJsonFromBlobUrl(url) {
//   const response = await fetch(url, {
//     headers: { Authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` }
//   });
//   if (!response.ok) throw new Error(`Failed to fetch blob JSON (${response.status})`);
//   return await response.json();
// }

// async function loadAssessmentHistory(topic) {
//   try {
//     const pathname = getHistoryBlobPath(topic);
//     const result = await list({ prefix: pathname, limit: 10 });

//     const blob = Array.isArray(result?.blobs)
//       ? result.blobs.find((item) => item.pathname === pathname)
//       : null;

//     if (!blob?.url) return [];

//     history = await loadAssessmentHistory(topic);

//     saveAssessmentHistory(topic, historyEntry).catch((error) => {
//       console.error("Unable to save assessment history:", error.message);
//     });

//     return history
//       .filter((item) => item && item.date && Array.isArray(item.scenario_scores))
//       .sort((a, b) => String(a.date).localeCompare(String(b.date)));
//   } catch (error) {
//     console.error("Failed to load assessment history from Blob:", error.message);
//     return [];
//   }
// }

// async function saveAssessmentHistory(topic, entry) {
//   try {
//     const pathname = getHistoryBlobPath(topic);
//     const existing = await loadAssessmentHistory(topic);
//     const entryDate = String(entry.date || new Date().toISOString().slice(0, 10));
//     const mergedEntry = { ...entry, date: entryDate, updated_at: entry.updated_at || new Date().toISOString() };
//     const existingIndex = existing.findIndex((item) => item.date === entryDate);
//     if (existingIndex >= 0) {
//       existing[existingIndex] = { ...existing[existingIndex], ...mergedEntry };
//     } else {
//       existing.push(mergedEntry);
//     }
//     existing.sort((a, b) => String(a.date).localeCompare(String(b.date)));
//     await put(pathname, JSON.stringify(existing, null, 2), {
//       access: "public",
//       addRandomSuffix: false,
//       contentType: "application/json",
//       allowOverwrite: true
//     });
//     return existing;
//   } catch (error) {
//     console.error("Failed to save assessment history to Blob:", error.message);
//     throw error;
//   }
// }

// ── OpenAI ─────────────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Utilities ──────────────────────────────────────────────────────────────────

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.send(JSON.stringify(body));
}

function startTimer(label) { return { label, startedAt: Date.now() }; }
function endTimer(timer) {
  if (!timer?.label || !timer?.startedAt) return;
  console.log(`${timer.label}: ${(Date.now() - timer.startedAt).toFixed(1)}ms`);
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timeoutId) };
}

async function fetchText(url, init = {}, timeoutMs = RSS_FETCH_TIMEOUT_MS) {
  const { signal, clear } = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, {
      ...init, signal, redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 future-scenario-predictor/1.0",
        Accept: "application/rss+xml, application/xml, text/xml, application/atom+xml, */*",
        ...(init.headers || {})
      }
    });
    if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
    return await res.text();
  } finally { clear(); }
}

async function fetchJson(url, init = {}, timeoutMs = JSON_FETCH_TIMEOUT_MS) {
  const { signal, clear } = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, {
      ...init, signal,
      headers: { "User-Agent": "future-scenario-predictor/1.0", Accept: "application/json", ...(init.headers || {}) }
    });
    if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
    return await res.json();
  } finally { clear(); }
}

function dedupeBy(items, getKey) {
  return Array.from(new Map(items.map((item) => [getKey(item), item])).values());
}

/**
 * Title similarity deduplication.
 * Removes articles where titles share ≥75% word overlap with an already-kept article.
 * Catches Google News duplicates that have different URLs but identical stories.
 */
function titleWordOverlap(a, b) {
  const tokenise = (s) =>
    s.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter((w) => w.length > 3);
  const ta = new Set(tokenise(a));
  const tb = tokenise(b);
  if (ta.size === 0 || tb.length === 0) return 0;
  const hits = tb.filter((w) => ta.has(w)).length;
  return hits / Math.max(ta.size, tb.length);
}

function dedupeByTitle(items, threshold = 0.75) {
  const kept = [];
  for (const item of items) {
    const isDupe = kept.some((k) => titleWordOverlap(item.title || "", k.title || "") >= threshold);
    if (!isDupe) kept.push(item);
  }
  return kept;
}

// ── Source blocking ─────────────────────────────────────────────────────────────
// IMPORTANT: Reuters and CNN are NO LONGER hardblocked.
// Users can now add any source manually and it will override this list.
// Only block sources that are structurally broken (wrong format, not news, etc.)

const STRUCTURALLY_BROKEN_SOURCES = [
  "reddit.com",
  "acleddata.com/blog/feed",
  "understandingwar.org/rss.xml"
];

function isBlockedOrBrokenSource(source, isUserAdded = false) {
  // User-added sources always bypass the block list
  if (isUserAdded) return false;

  const url = String(source?.url || "").toLowerCase();
  if (!url) return true;

  return STRUCTURALLY_BROKEN_SOURCES.some((blocked) => url.includes(blocked));
}

function normalizeSourceUrl(raw) {
  const input = String(raw || "").trim();
  if (!input) return "";
  try {
    const parsed = new URL(input);
    parsed.protocol = "https:";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return input.toLowerCase().replace(/\/$/, "");
  }
}

// ── Keyword matching ───────────────────────────────────────────────────────────

function isRelevantToTopic(item, topicConfig) {
  const title = String(item.title || "").toLowerCase();
  const snippet = String(item.contentSnippet || "").toLowerCase();
  const haystack = `${title} ${snippet}`;

  const primaryTerms = topicConfig.keywordFilter.slice(0, 5);
  const hasPrimaryHit = primaryTerms.some((term) => haystack.includes(term));
  if (hasPrimaryHit) return true;

  const allHits = topicConfig.keywordFilter.filter((term) => haystack.includes(term)).length;
  return allHits >= MIN_MATCHES_REQUIRED;
}

function scoreAndSort(items, savedSourceNames = [], topicConfig) {
  return items
    .map((item) => {
      const haystack = `${item.title} ${item.contentSnippet}`.toLowerCase();
      let matches = 0;
      for (const keyword of topicConfig.keywordFilter) {
        if (haystack.includes(keyword)) matches += 1;
      }
      const savedBoost  = savedSourceNames.includes(item.source) ? 0.75 : 0;
      const titleBoost  = topicConfig.keywordFilter.slice(0, 3).some((t) => item.title?.toLowerCase().includes(t)) ? 1 : 0;
      const score = matches + savedBoost + titleBoost;
      return { ...item, _matches: matches, _score: score };
    })
    .filter((item) => item._matches >= MIN_MATCHES_REQUIRED || savedSourceNames.includes(item.source))
    .filter((item) => isRelevantToTopic(item, topicConfig) || savedSourceNames.includes(item.source))
    .sort((a, b) => b._score - a._score || (b.isoDate || "").localeCompare(a.isoDate || ""));
}

// ── RSS Fetching ───────────────────────────────────────────────────────────────

async function fetchRssItems(source, topicConfig) {
  async function fetchFromUrl(urlToFetch, label) {
    const xml = await fetchText(urlToFetch, {}, RSS_FETCH_TIMEOUT_MS);
    const feed = await parser.parseString(xml);
    const items = Array.isArray(feed.items) ? feed.items : [];
    return items.slice(0, MAX_ITEMS_PER_FEED).map((item) => ({
      source: source.name,
      url: item.link || source.url,
      title: normalizeWhitespace(item.title),
      contentSnippet: normalizeWhitespace(item.contentSnippet || item.summary || "").slice(0, 300),
      content: "",
      isoDate: item.isoDate || item.pubDate || null,
      keywords: topicConfig.keywordFilter
    }));
  }

  try {
    return await fetchFromUrl(source.url, "direct");
  } catch (error) {
    console.error(`Failed to fetch ${source.name} from direct URL:`, error.message);
    if (source.homepage) {
      try {
        const discovery = await discoverFeedFromWebsite(source.homepage);
        if (discovery.ok && discovery.source.feedUrl && discovery.source.feedUrl !== source.url) {
          console.log(`Discovered alternate feed for ${source.name}: ${discovery.source.feedUrl}`);
          return await fetchFromUrl(discovery.source.feedUrl, "discovered");
        }
      } catch (fallbackError) {
        console.error(`Feed discovery failed for ${source.name}:`, fallbackError.message);
      }
    }
    return [];
  }
}

// ── NewsAPI Fetching ───────────────────────────────────────────────────────────
// Parallel data source. Runs alongside RSS — does not replace it.
// Sign up free at https://newsapi.org and set NEWSAPI_KEY env var.

async function fetchNewsApiArticles(topicConfig) {
  const apiKey = process.env.NEWSAPI_KEY;
  if (!apiKey) {
    console.log("[NewsAPI] NEWSAPI_KEY not set — skipping.");
    return [];
  }

  try {
    const query = encodeURIComponent(topicConfig.newsApiQuery || topicConfig.label);
    const url = `https://newsapi.org/v2/everything?q=${query}&language=en&sortBy=publishedAt&pageSize=15&apiKey=${apiKey}`;
    const data = await fetchJson(url, {}, JSON_FETCH_TIMEOUT_MS);

    if (data.status !== "ok" || !Array.isArray(data.articles)) {
      console.warn("[NewsAPI] Unexpected response:", data.status, data.message);
      return [];
    }

    console.log(`[NewsAPI] Fetched ${data.articles.length} articles for query: ${topicConfig.newsApiQuery}`);

    return data.articles
      .filter((a) => a.title && a.title !== "[Removed]")
      .map((article) => ({
        source: article.source?.name || "NewsAPI",
        url: article.url,
        title: normalizeWhitespace(article.title),
        contentSnippet: normalizeWhitespace(article.description || "").slice(0, 300),
        content: "",
        isoDate: article.publishedAt,
        keywords: topicConfig.keywordFilter
      }));
  } catch (error) {
    console.error("[NewsAPI] Fetch failed:", error.message);
    return [];
  }
}

// ── WorldMonitor Fetching ──────────────────────────────────────────────────────
// Polls the separate WorldMonitor scraper service.
// Set WORLDMONITOR_SCRAPER_URL to your deployed scraper URL.
// Set WORLDMONITOR_SECRET_TOKEN if you enabled auth on the scraper.

async function fetchWorldMonitorArticles(topicConfig) {
  const scraperUrl = process.env.WORLDMONITOR_SCRAPER_URL;
  if (!scraperUrl) {
    console.log("[WorldMonitor] WORLDMONITOR_SCRAPER_URL not set — skipping.");
    return [];
  }

  try {
    const headers = {};
    if (process.env.WORLDMONITOR_SECRET_TOKEN) {
      headers["Authorization"] = `Bearer ${process.env.WORLDMONITOR_SECRET_TOKEN}`;
    }

    const data = await fetchJson(`${scraperUrl.replace(/\/$/, "")}/articles`, { headers }, JSON_FETCH_TIMEOUT_MS);

    if (!Array.isArray(data.articles)) {
      console.warn("[WorldMonitor] Unexpected response format");
      return [];
    }

    console.log(`[WorldMonitor] Received ${data.articles.length} cached articles (scraped: ${data.lastScrapedAt})`);

    // Filter WorldMonitor articles through the topic keyword filter
    return data.articles
      .filter((a) => a.title)
      .map((article) => ({
        source: "WorldMonitor",
        url: article.url || "https://worldmonitor.app",
        title: normalizeWhitespace(article.title),
        contentSnippet: normalizeWhitespace(article.contentSnippet || "").slice(0, 300),
        content: "",
        isoDate: article.isoDate || null,
        keywords: topicConfig.keywordFilter
      }));
  } catch (error) {
    console.error("[WorldMonitor] Fetch failed:", error.message);
    return [];
  }
}

// ── Coverage Aggregation ───────────────────────────────────────────────────────

function ensureSavedSourcePresence(scoredItems, savedSourceNames = [], maxTotal = MAX_FILTERED_ITEMS) {
  const result = [];
  const usedUrls = new Set();

  for (const sourceName of savedSourceNames) {
    const match = scoredItems.find((item) => item.source === sourceName && !usedUrls.has(item.url));
    if (match) {
      result.push(match);
      usedUrls.add(match.url);
    }
  }

  for (const item of scoredItems) {
    if (result.length >= maxTotal) break;
    if (!usedUrls.has(item.url)) {
      result.push(item);
      usedUrls.add(item.url);
    }
  }

  return result.slice(0, maxTotal);
}

async function collectTopicCoverage(topicConfig, savedSources = []) {
  const defaultSources = Array.isArray(topicConfig.sources) ? topicConfig.sources : [];
  const extraSources   = Array.isArray(savedSources) ? savedSources.filter((s) => s.enabled !== false) : [];
  const allSources     = [...defaultSources, ...extraSources];

  const uniqueSources = Array.from(
    new Map(
      allSources.map((source) => {
        const normalizedUrl = normalizeSourceUrl(source.url);
        return [normalizedUrl, {
          name: source.name,
          url: normalizedUrl,
          type: source.type || "rss",
          enabled: source.enabled !== false,
          homepage: source.homepage || "",
          isUserAdded: extraSources.some((s) => s.name === source.name)
        }];
      })
    ).values()
  ).filter((source) => source.url);

const rssSources = uniqueSources.filter(
  (source) =>
    String(source.type || "rss").toLowerCase() === "rss" &&
    !isBlockedOrBrokenSource(source, source.isUserAdded)
);

const liveRssSources = rssSources.slice(0, 5);

console.log("RSS SOURCES:", rssSources.map((s) => `${s.name}${s.isUserAdded ? " [user]" : ""}`));

const [rssGroups, newsApiItems, worldMonitorItems] = await Promise.all([
  Promise.all(liveRssSources.map((source) => fetchRssItems(source, topicConfig))),
  fetchNewsApiArticles(topicConfig),
  fetchWorldMonitorArticles(topicConfig)
]);

  const rssItems   = rssGroups.flat();
  const flattened  = [...rssItems, ...newsApiItems, ...worldMonitorItems];

  // Dedup: URL first, then title similarity
  const dedupedByUrl   = dedupeBy(flattened, (item) => item.url);
  const dedupedByTitle = dedupeByTitle(dedupedByUrl);

  console.log(`Articles after dedup: ${dedupedByTitle.length} (from ${flattened.length} raw)`);

  const savedSourceNames = extraSources.map((s) => s.name);
  const scored   = scoreAndSort(dedupedByTitle, savedSourceNames, topicConfig);
  const filtered = ensureSavedSourcePresence(scored, savedSourceNames, MAX_FILTERED_ITEMS);
  const shortlisted = filtered.slice(0, MAX_ARTICLES_FOR_MODEL);

  console.log("FINAL ARTICLES:", shortlisted.map((item) => `[${item.source}] ${item.title}`));

  return shortlisted.map((item) => ({
    source: item.source,
    url: item.url,
    title: item.title,
    published_at: item.isoDate,
    snippet: String(item.contentSnippet || "").slice(0, 220)
  }));
}

// ── Oil Signal ─────────────────────────────────────────────────────────────────

async function fetchOilSignal() {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) {
    return {
      source: "Alpha Vantage", status: "unavailable", latest: null,
      signal: { name: "oil prices", reading: "Oil API key not configured.", direction: "neutral", confidence: "Low", sources: [] }
    };
  }

  try {
    const url = `https://www.alphavantage.co/query?function=BRENT&interval=monthly&apikey=${encodeURIComponent(apiKey)}`;
    const data = await fetchJson(url, {}, JSON_FETCH_TIMEOUT_MS);
    const series  = Array.isArray(data.data) ? data.data : [];
    const latest  = series[0] ? Number(series[0].value) : null;
    const previous = series[1] ? Number(series[1].value) : null;

    let direction = "neutral";
    let reading   = "Brent data available but move is limited.";
    let confidence = "Medium";

    if (latest != null && previous != null) {
      const deltaPct = previous === 0 ? 0 : ((latest - previous) / previous) * 100;
      if (latest >= 85 || deltaPct >= 8) {
        direction = "escalatory";
        reading   = `Brent is elevated at ${latest.toFixed(2)} USD/bbl, up from ${previous.toFixed(2)}.`;
      } else if (latest <= 70 && deltaPct <= -5) {
        direction = "de-escalatory";
        reading   = `Brent has eased to ${latest.toFixed(2)} USD/bbl from ${previous.toFixed(2)}.`;
      } else {
        reading   = `Brent is ${latest.toFixed(2)} USD/bbl versus ${previous.toFixed(2)} previously.`;
      }
    } else {
      confidence = "Low";
      reading    = "Oil feed returned insufficient data.";
    }

    return { source: "Alpha Vantage", status: "ok", latest, previous, signal: { name: "oil prices", reading, direction, confidence, sources: [] } };
  } catch (error) {
    console.error("Oil signal failed:", error.message);
    return { source: "Alpha Vantage", status: "error", latest: null, signal: { name: "oil prices", reading: `Oil feed unavailable: ${error.message}`, direction: "neutral", confidence: "Low", sources: [] } };
  }
}

// ── Polymarket Signal ──────────────────────────────────────────────────────────

function scorePolymarketScenario(question, yesPrice, scenarioNames) {
  const q = String(question || "").toLowerCase();
  const p = Number(yesPrice || 0);

  // Try to map to scenario names dynamically
  for (const name of scenarioNames) {
    const keywords = name.toLowerCase().split(/\s+/);
    if (keywords.some((kw) => q.includes(kw))) {
      return { scenario: name, weight: p };
    }
  }

  // Fallback heuristics for Iran topic
  if (q.includes("hormuz") || q.includes("gulf war") || q.includes("regional war")) return { scenario: scenarioNames[0], weight: p };
  if (q.includes("ceasefire") || q.includes("deal") || q.includes("negotiation")) return { scenario: scenarioNames[scenarioNames.length - 1], weight: 1 - p };
  return null;
}

async function fetchPolymarketSignal(topicConfig) {
  try {
    const markets = await fetchJson("https://gamma-api.polymarket.com/markets", {}, JSON_FETCH_TIMEOUT_MS);
    const active = Array.isArray(markets) ? markets : [];
    const scenarioNames = topicConfig.scenarios.map((s) => s.name);

    const filtered = active
      .filter((m) => m.active && !m.closed)
      .filter((m) => {
        const text = `${m.question || ""} ${m.description || ""}`.toLowerCase();
        return topicConfig.polymarketSearchTerms.some((term) => text.includes(term));
      })
      .slice(0, 20);

    const weights = new Map(scenarioNames.map((name) => [name, 0]));
    const matchedMarkets = [];

    for (const market of filtered) {
      let outcomePrices = [];
      if (Array.isArray(market.outcomePrices)) outcomePrices = market.outcomePrices;
      else if (typeof market.outcomePrices === "string") {
        try { outcomePrices = JSON.parse(market.outcomePrices || "[]"); } catch { outcomePrices = []; }
      }

      const yesPrice = Number(outcomePrices[0] || 0);
      const mapped   = scorePolymarketScenario(market.question, yesPrice, scenarioNames);
      if (mapped && weights.has(mapped.scenario)) {
        weights.set(mapped.scenario, weights.get(mapped.scenario) + mapped.weight);
        matchedMarkets.push({ question: market.question, scenario: mapped.scenario, yesPrice });
      }
    }

    const topScenario = [...weights.entries()].sort((a, b) => b[1] - a[1])[0];
    const reading = matchedMarkets.length
      ? `Polymarket signals lean toward ${topScenario[0]} based on ${matchedMarkets.length} matched live markets.`
      : "No strongly matched Polymarket markets found for this topic.";

    return {
      source: "Polymarket", status: "ok",
      weights: Object.fromEntries(weights),
      matchedMarkets,
      signal: {
        name: "prediction market odds", reading,
        direction: matchedMarkets.length ? "escalatory" : "neutral",
        confidence: matchedMarkets.length >= 3 ? "Medium" : "Low",
        sources: []
      }
    };
  } catch (error) {
    console.error("Polymarket fetch failed:", error.message);
    return {
      source: "Polymarket", status: "error", weights: {}, matchedMarkets: [],
      signal: { name: "prediction market odds", reading: `Prediction market feed unavailable: ${error.message}`, direction: "neutral", confidence: "Low", sources: [] }
    };
  }
}

// ── Prompt Builder ─────────────────────────────────────────────────────────────

function buildPrompt(topicConfig, articles, externalSignals) {
  const compactArticles = articles.slice(0, MAX_ARTICLES_FOR_MODEL).map((a) => ({
    s: a.source, t: a.title, u: a.url, p: a.published_at, n: a.snippet
  }));
  const compactSignals = externalSignals.map((s) => ({
    source: s.source, signal: s.signal,
    weights: s.weights || undefined,
    matchedMarkets: Array.isArray(s.matchedMarkets) ? s.matchedMarkets.slice(0, 3) : undefined
  }));

  return [
    `Assess the current outlook for: ${topicConfig.label}.`,
    "Use only supplied evidence. Return valid JSON only. Keep output concise.",
    "Use exactly these scenario names:",
    JSON.stringify(topicConfig.scenarios.map((s) => s.name)),
    "Tracked signals:",
    JSON.stringify(topicConfig.trackedSignals),
    "Scenario definitions:",
    JSON.stringify(topicConfig.scenarios.map((s) => ({ name: s.name, description: s.description, scenarioSignals: s.scenarioSignals }))),
    "For calculation.scenarios, include only: name, ai_score, market_boost, final_score, reasoning.",
    "Set reasoning to one short sentence only.",
    "Articles:",
    JSON.stringify(compactArticles),
    "External signals:",
    JSON.stringify(compactSignals)
  ].join("\n");
}

// ── Response Schema ────────────────────────────────────────────────────────────

const responseSchema = {
  type: "object", additionalProperties: false,
  properties: {
    summary: { type: "string" },
    scenarios: {
      type: "array", minItems: 4, maxItems: 4,
      items: {
        type: "object", additionalProperties: false,
        properties: { name: { type: "string" }, score: { type: "number" }, description: { type: "string" } },
        required: ["name", "score", "description"]
      }
    },
    signals: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          name: { type: "string" }, reading: { type: "string" },
          direction: { type: "string", enum: ["escalatory", "neutral", "de-escalatory"] },
          confidence: { type: "string", enum: ["Low", "Medium", "High"] },
          sources: {
            type: "array",
            items: {
              type: "object", additionalProperties: false,
              properties: { title: { type: "string" }, url: { type: "string" }, source: { type: "string" } },
              required: ["title", "url", "source"]
            }
          }
        },
        required: ["name", "reading", "direction", "confidence", "sources"]
      }
    },
    calculation: {
      type: "object", additionalProperties: false,
      properties: {
        scenarios: {
          type: "array",
          items: {
            type: "object", additionalProperties: false,
            properties: {
              name: { type: "string" }, ai_score: { type: "number" },
              market_boost: { type: "number" }, final_score: { type: "number" }, reasoning: { type: "string" }
            },
            required: ["name", "ai_score", "market_boost", "final_score", "reasoning"]
          }
        }
      },
      required: ["scenarios"]
    }
  },
  required: ["summary", "scenarios", "signals", "calculation"]
};

// ── Score Normalisation ────────────────────────────────────────────────────────

function normalizeScenarioScores(output, scenariosFromConfig, polymarketWeights = {}) {
  const byName = new Map(output.scenarios.map((item) => [String(item.name || "").trim().toLowerCase(), item]));

  const merged = scenariosFromConfig.map((scenario) => {
    const found      = byName.get(scenario.name.toLowerCase());
    const aiScore    = Number(found?.score || 0);
    const marketBoost = Number(polymarketWeights[scenario.name] || 0) * 20;
    return { name: scenario.name, description: found?.description || scenario.description, score: aiScore + marketBoost };
  });

  const rawTotal = merged.reduce((sum, item) => sum + item.score, 0);
  if (rawTotal <= 0) {
    const equal = Math.floor(100 / merged.length);
    return merged.map((item, i) => ({ ...item, score: i === merged.length - 1 ? 100 - equal * (merged.length - 1) : equal }));
  }

  let running = 0;
  return merged.map((item, i) => {
    if (i === merged.length - 1) return { ...item, score: Math.max(0, 100 - running) };
    const normalized = Math.round((item.score / rawTotal) * 100);
    running += normalized;
    return { ...item, score: normalized };
  });
}

function upsertSignal(signals, newSignal) {
  const idx = signals.findIndex((s) => s.name === newSignal.name);
  if (idx >= 0) signals[idx] = newSignal;
  else signals.push(newSignal);
}

// ── JSON parsing helpers ───────────────────────────────────────────────────────

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Model returned empty output.");
  const firstBrace = raw.indexOf("{");
  const lastBrace  = raw.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) throw new Error("No complete JSON object in model output.");
  return raw.slice(firstBrace, lastBrace + 1);
}

function safeParseModelJson(response) {
  const candidates = [];
  if (typeof response?.output_text === "string" && response.output_text.trim()) candidates.push(response.output_text);
  if (Array.isArray(response?.output)) {
    for (const item of response.output) {
      if (Array.isArray(item?.content)) {
        for (const content of item.content) {
          if (typeof content?.text === "string" && content.text.trim()) candidates.push(content.text);
        }
      }
    }
  }
  let lastError = null;
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch (err) {
      lastError = err;
      try { return JSON.parse(extractJsonObject(candidate)); } catch (err2) { lastError = err2; }
    }
  }
  throw new Error(`Failed to parse model JSON. ${lastError?.message || "No parseable content."}`);
}

// ── Fallback Assessment ────────────────────────────────────────────────────────

function buildFallbackAssessment(topicConfig, articles, externalSignals, summaryPrefix = "") {
  const polymarket = externalSignals.find((s) => s.source === "Polymarket");
  const fallbackScenarios = normalizeScenarioScores(
    { scenarios: topicConfig.scenarios.map((s, i) => ({ name: s.name, description: s.description, score: [15, 20, 35, 30][i] || 25 })) },
    topicConfig.scenarios,
    polymarket?.weights || {}
  );
  const fallbackSignals = topicConfig.trackedSignals.map((signalName) => {
    const ext = externalSignals.find((s) => s.signal?.name === signalName);
    if (ext?.signal) return ext.signal;
    const supportingArticles = articles.filter((a) => `${a.title} ${a.snippet}`.toLowerCase().includes(signalName.split(" ")[0])).slice(0, 2).map((a) => ({ title: a.title, url: a.url, source: a.source }));
    return { name: signalName, reading: supportingArticles.length ? "Relevant reporting exists but a fallback assessment was used." : "No clear reading available.", direction: "neutral", confidence: "Low", sources: supportingArticles };
  });
  return {
    summary: `${summaryPrefix} Current reporting still points to sustained pressure in the ${topicConfig.label} domain.`.trim(),
    scenarios: fallbackScenarios,
    signals: fallbackSignals,
    calculation: { scenarios: topicConfig.scenarios.map((s) => { const fs = fallbackScenarios.find((x) => x.name === s.name); return { name: s.name, ai_score: 0, market_boost: Number(polymarket?.weights?.[s.name] || 0) * 20, final_score: Number(fs?.score || 0), reasoning: "Fallback assessment used." }; }) }
  };
}

// ── Assessment Generation ──────────────────────────────────────────────────────

async function generateScenarioAssessment(topicConfig, articles, externalSignals) {
  if (!articles.length && !externalSignals.length) {
    return {
      summary: "Not enough current source material was available to generate a live assessment.",
      scenarios: topicConfig.scenarios.map((s) => ({ ...s, score: 25 })),
      signals: topicConfig.trackedSignals.map((s) => ({ name: s, reading: "No recent evidence available.", direction: "neutral", confidence: "Low", sources: [] })),
      calculation: { scenarios: topicConfig.scenarios.map((s) => ({ name: s.name, ai_score: 0, market_boost: 0, final_score: 25, reasoning: "No live evidence." })) }
    };
  }

  const prompt = buildPrompt(topicConfig, articles, externalSignals);

  let response;
  try {
    response = await Promise.race([
      openai.responses.create({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        input: [
          { role: "developer", content: [{ type: "input_text", text: "Produce a concise scenario assessment using only the supplied source material. Return JSON only." }] },
          { role: "user",      content: [{ type: "input_text", text: prompt }] }
        ],
        temperature: 0.2,
        max_output_tokens: 4000,
        text: { format: { type: "json_schema", name: "scenario_assessment", schema: responseSchema, strict: true } }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`OpenAI request exceeded ${OPENAI_TIMEOUT_FALLBACK_MS}ms.`)), OPENAI_TIMEOUT_FALLBACK_MS))
    ]);
  } catch (error) {
    console.error("OpenAI scenario generation failed:", error.message);
    return buildFallbackAssessment(topicConfig, articles, externalSignals, "The model request failed or timed out.");
  }

  let parsed;
  try {
    parsed = safeParseModelJson(response);
  } catch (parseError) {
    console.error("Model JSON parse failed:", parseError.message);
    return buildFallbackAssessment(topicConfig, articles, externalSignals, "The model returned malformed JSON.");
  }

  if (!parsed.scenarios || !Array.isArray(parsed.scenarios) || parsed.scenarios.every((s) => Number(s.score || 0) <= 0)) {
    parsed.scenarios = topicConfig.scenarios.map((s, i) => ({ name: s.name, description: s.description, score: [15, 20, 35, 30][i] || 25 }));
  }

  const polymarket = externalSignals.find((s) => s.source === "Polymarket");
  const normalizedScenarios = normalizeScenarioScores(parsed, topicConfig.scenarios, polymarket?.weights || {});

  const calculationScenarios = topicConfig.scenarios.map((scenario) => {
    const rawCalc   = (parsed.calculation?.scenarios || []).find((item) => String(item.name || "").trim().toLowerCase() === scenario.name.toLowerCase());
    const normalized = normalizedScenarios.find((item) => item.name.toLowerCase() === scenario.name.toLowerCase());
    return {
      name: scenario.name,
      ai_score: Number(rawCalc?.ai_score || 0),
      market_boost: Number(rawCalc?.market_boost || Number(polymarket?.weights?.[scenario.name] || 0) * 20),
      final_score: Number(normalized?.score || 0),
      reasoning: typeof rawCalc?.reasoning === "string" && rawCalc.reasoning.trim() ? rawCalc.reasoning.trim() : "No short reasoning returned."
    };
  });

  const signals = Array.isArray(parsed.signals) ? [...parsed.signals] : [];
  for (const ext of externalSignals) {
    if (ext.signal?.name) upsertSignal(signals, ext.signal);
  }

  return { summary: parsed.summary, scenarios: normalizedScenarios, signals, calculation: { scenarios: calculationScenarios } };
}

// ── HTTP Handler ───────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return json(res, 200, { ok: true });
  if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });
  if (!process.env.OPENAI_API_KEY) return json(res, 500, { error: "missing_openai_api_key", message: "OPENAI_API_KEY is not set." });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return json(res, 500, { error: "missing_blob_config", message: "BLOB_READ_WRITE_TOKEN is not set." });

  try {
    const totalTimer = startTimer("scenario-assessment-total");
    const topic      = req.query.topic || "iran";
    const topicConfig = getTopicConfig(topic);

    const savedSourcesTimer = startTimer("load-saved-sources");
    const savedSources = await getMergedSavedSources(topic);
    endTimer(savedSourcesTimer);

    const coverageTimer  = startTimer("collect-topic-coverage");
    const articlesPromise = collectTopicCoverage(topicConfig, savedSources);

    const oilTimer       = startTimer("fetch-oil-signal");
    const oilSignalPromise = fetchOilSignal().finally(() => endTimer(oilTimer));

    const polyTimer      = startTimer("fetch-polymarket-signal");
    const polymarketSignalPromise = fetchPolymarketSignal(topicConfig).finally(() => endTimer(polyTimer));

    const articles = await articlesPromise;
    endTimer(coverageTimer);

    const [oilSignal, polymarketSignal] = await Promise.all([oilSignalPromise, polymarketSignalPromise]);
    const externalSignals = [oilSignal, polymarketSignal];

    const assessmentTimer = startTimer("generate-assessment");
    const assessment = await generateScenarioAssessment(topicConfig, articles, externalSignals);
    endTimer(assessmentTimer);

    const nowIso  = new Date().toISOString();
    const today   = nowIso.slice(0, 10);
    const topArticle = articles[0] || null;

    const uniqueUsedSources = Array.from(
      new Map(articles.map((a) => [String(a.source || "").trim().toLowerCase(), { name: a.source, url: a.url }])).values()
    ).sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

    const historyEntry = {
      date: today, updated_at: nowIso,
      summary: assessment.summary,
      short_summary: String(assessment.summary || "").replace(/\s+/g, " ").trim().slice(0, 180),
      top_headline: topArticle ? `${topArticle.source}: ${topArticle.title}` : "No headline available.",
      top_headline_url: topArticle?.url || null,
      used_sources: uniqueUsedSources,
      article_count: articles.length,
      scenario_scores: assessment.scenarios.map((item) => ({ name: item.name, score: Number(item.score || 0) }))
    };

let history = [];
const citedSources = Array.from(
  new Map(
    (assessment.signals || [])
      .flatMap((s) => Array.isArray(s.sources) ? s.sources : [])
      .map((s) => [
        String(s.url || "").trim(),
        { title: `${s.source}: ${s.title}`, url: s.url }
      ])
  ).values()
);

const responsePayload = {
  topic: topicConfig.label,
  updated_at: new Date().toISOString(),
  summary: assessment.summary,
  scenarios: assessment.scenarios,
  signals: assessment.signals,
  calculation: assessment.calculation,
  history: [],
  available_topics: listAvailableTopics(),
  sources: [
    ...citedSources,
    { title: "Polymarket live markets", url: "https://polymarket.com/" }
  ],
  meta: {
    oil: oilSignal,
    polymarket: {
      source: polymarketSignal.source,
      matchedMarkets: polymarketSignal.matchedMarkets
    },
    saved_sources: savedSources,
    used_article_sources: [...new Set(articles.map((a) => a.source))]
  }
};


try {
  await saveLatestAssessment(topic, responsePayload);
} catch (error) {
  console.error("Unable to save latest assessment:", error.message);
}

try {
  history = await saveAssessmentHistory(topic, historyEntry);
} catch (error) {
  console.error("Unable to save assessment history:", error.message);
  history = await loadAssessmentHistory(topic);
}

responsePayload.history = Array.isArray(history) ? history.slice(-30) : [];

endTimer(totalTimer);
return json(res, 200, responsePayload);


  } catch (error) {
    console.error("Scenario assessment failed:", error);
    return json(res, 500, { error: "scenario_assessment_failed", message: error.message });
  }
}
