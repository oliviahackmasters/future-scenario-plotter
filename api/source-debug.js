import Parser from "rss-parser";
import { getMergedSavedSources } from "../lib/source-store.js";

const parser = new Parser();
const DEFAULT_TIMEOUT_MS = 7000;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function withTimeout(ms = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timeoutId) };
}

async function inspectRssSource(source) {
  const startedAt = Date.now();
  const { signal, clear } = withTimeout();

  try {
    const response = await fetch(source.url, {
      signal,
      redirect: "follow",
      headers: {
        "User-Agent": "future-scenario-plotter-source-debug/1.0",
        Accept: "application/rss+xml, application/xml, text/xml, application/atom+xml, application/json, */*"
      }
    });

    const text = await response.text();
    const contentType = response.headers.get("content-type") || "";
    let itemCount = 0;
    let sampleTitles = [];

    if (contentType.includes("json") || text.trim().startsWith("{")) {
      const json = JSON.parse(text);
      const articles = Array.isArray(json.articles) ? json.articles : [];
      itemCount = Number(json.result_count ?? articles.length ?? 0);
      sampleTitles = articles.slice(0, 3).map((item) => item.title).filter(Boolean);
    } else {
      const feed = await parser.parseString(text);
      const items = Array.isArray(feed.items) ? feed.items : [];
      itemCount = items.length;
      sampleTitles = items.slice(0, 3).map((item) => item.title).filter(Boolean);
    }

    return {
      name: source.name,
      url: source.url,
      homepage: source.homepage || null,
      type: source.type || "rss",
      discovered_by: source.discovered_by || null,
      enabled: source.enabled !== false,
      ok: response.ok,
      status: response.status,
      content_type: contentType,
      item_count: itemCount,
      sample_titles: sampleTitles,
      elapsed_ms: Date.now() - startedAt
    };
  } catch (error) {
    return {
      name: source.name,
      url: source.url,
      homepage: source.homepage || null,
      type: source.type || "rss",
      discovered_by: source.discovered_by || null,
      enabled: source.enabled !== false,
      ok: false,
      error: error.message || "Fetch failed",
      item_count: 0,
      sample_titles: [],
      elapsed_ms: Date.now() - startedAt
    };
  } finally {
    clear();
  }
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const topic = String(req.query.topic || "iran").trim().toLowerCase();
  const includeFetch = req.query.fetch !== "0";

  try {
    const sources = await getMergedSavedSources(topic);
    const enabledSources = sources.filter((source) => source.enabled !== false);
    const inspected = includeFetch
      ? await Promise.all(enabledSources.map(inspectRssSource))
      : enabledSources.map((source) => ({
          name: source.name,
          url: source.url,
          homepage: source.homepage || null,
          type: source.type || "rss",
          discovered_by: source.discovered_by || null,
          enabled: source.enabled !== false
        }));

    return res.status(200).json({
      topic,
      checked_at: new Date().toISOString(),
      env: {
        has_tavily_api_key: Boolean(process.env.TAVILY_API_KEY),
        has_public_base_url: Boolean(process.env.PUBLIC_BASE_URL),
        public_base_url: process.env.PUBLIC_BASE_URL || null,
        has_vercel_url: Boolean(process.env.VERCEL_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL)
      },
      source_count: sources.length,
      enabled_source_count: enabledSources.length,
      sources: inspected,
      totals: {
        ok_sources: inspected.filter((source) => source.ok).length,
        failed_sources: inspected.filter((source) => source.ok === false).length,
        total_items_returned: inspected.reduce((sum, source) => sum + Number(source.item_count || 0), 0)
      }
    });
  } catch (error) {
    console.error("Source debug failed:", error);
    return res.status(500).json({
      error: error.message || "Source debug failed",
      topic,
      env: {
        has_tavily_api_key: Boolean(process.env.TAVILY_API_KEY),
        has_public_base_url: Boolean(process.env.PUBLIC_BASE_URL),
        public_base_url: process.env.PUBLIC_BASE_URL || null,
        has_vercel_url: Boolean(process.env.VERCEL_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL)
      }
    });
  }
}
