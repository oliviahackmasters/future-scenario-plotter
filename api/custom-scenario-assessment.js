import Parser from "rss-parser";
import OpenAI from "openai";
import {
  buildScenarioSearchQuery,
  fetchTavilyArticles,
  hostnameFromUrl
} from "../lib/tavily-search.js";

const parser = new Parser();
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const DEFAULT_SOURCES = [
  { id: "bbc-world", name: "BBC World", url: "http://feeds.bbci.co.uk/news/world/rss.xml", reliability: 82, enabled: true, type: "rss" },
  { id: "guardian-world", name: "Guardian World", url: "https://www.theguardian.com/world/rss", reliability: 78, enabled: true, type: "rss" },
  { id: "al-jazeera", name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml", reliability: 75, enabled: true, type: "rss" },
  { id: "ft-news", name: "Financial Times", url: "https://www.ft.com/news-feed?format=rss", reliability: 84, enabled: true, type: "rss" },
  { id: "google-news", name: "Google News", url: "https://news.google.com/rss?hl=en-GB&gl=GB&ceid=GB:en", reliability: 65, enabled: true, type: "rss" }
];

const MAX_SCENARIOS = 4;
const MAX_SIGNALS_PER_SCENARIO = 12;
const MAX_SOURCES = 20;
const MAX_ITEMS_PER_SOURCE = 8;
const MAX_ITEMS_FOR_MODEL = 24;
const MAX_TAVILY_FALLBACK_PER_SOURCE = 2;
const RSS_TIMEOUT_MS = 5000;
const OPENAI_TIMEOUT_MS = 24000;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, status, body) {
  setCors(res);
  res.status(status).setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(body));
}

function cleanText(value, max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normaliseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function tokenise(value) {
  return cleanText(value, 1000)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

function sanitiseScenario(input, index) {
  const name = cleanText(input?.name || input?.description || `Scenario ${index + 1}`, 120);
  const description = cleanText(input?.description || input?.name || name, 500);
  const signals = Array.isArray(input?.signals)
    ? input.signals
    : typeof input?.signals === "string"
      ? input.signals.split(/[\n,;]+/)
      : [];

  return {
    name,
    description,
    signals: signals.map((signal) => cleanText(signal, 140)).filter(Boolean).slice(0, MAX_SIGNALS_PER_SCENARIO)
  };
}

function isTavilySource(source = {}) {
  const type = String(source.type || "").trim().toLowerCase();
  return ["web", "site", "domain", "tavily"].includes(type);
}

function sanitiseSource(input, index) {
  const url = normaliseUrl(input?.url || input?.homepage || input?.domain);
  if (!url) return null;
  const type = cleanText(input?.type || "rss", 40).toLowerCase();
  return {
    id: cleanText(input?.id || `source-${index + 1}`, 80),
    name: cleanText(input?.name || new URL(url).hostname, 120),
    url,
    homepage: normaliseUrl(input?.homepage || url),
    domain: hostnameFromUrl(input?.domain || input?.homepage || url),
    type,
    reliability: Math.max(0, Math.min(100, Number(input?.reliability ?? input?.reliability_percent ?? 70))),
    enabled: input?.enabled !== false
  };
}

function sanitisePayload(body = {}) {
  const scenarios = (Array.isArray(body.scenarios) ? body.scenarios : [])
    .map(sanitiseScenario)
    .filter((scenario) => scenario.name && scenario.signals.length)
    .slice(0, MAX_SCENARIOS);

  const suppliedSources = Array.isArray(body.sources) ? body.sources : DEFAULT_SOURCES;
  const sources = suppliedSources
    .map(sanitiseSource)
    .filter((source) => source && source.enabled)
    .slice(0, MAX_SOURCES);

  return { scenarios, sources };
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timeout) };
}

async function fetchFeed(source) {
  if (isTavilySource(source)) return [];

  const { signal, clear } = withTimeout(RSS_TIMEOUT_MS);
  try {
    const response = await fetch(source.url, {
      signal,
      redirect: "follow",
      headers: {
        "User-Agent": "future-scenario-plotter/1.0",
        Accept: "application/rss+xml, application/xml, text/xml, application/atom+xml, */*"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const xml = await response.text();
    const feed = await parser.parseString(xml);
    return (feed.items || []).slice(0, MAX_ITEMS_PER_SOURCE).map((item) => ({
      source_id: source.id,
      source: source.name,
      source_url: source.url,
      reliability: source.reliability,
      title: cleanText(item.title, 220),
      snippet: cleanText(item.contentSnippet || item.summary || item.content || "", 360),
      url: item.link || source.url,
      published_at: item.isoDate || item.pubDate || null,
      searchProvider: "rss"
    }));
  } finally {
    clear();
  }
}

function buildFocusedTavilyQuery({ scenarios }) {
  const terms = Array.from(new Set([
    ...scenarios.map((scenario) => scenario.name),
    ...scenarios.flatMap((scenario) => scenario.signals),
    "Iran",
    "Strait of Hormuz",
    "Gulf shipping",
    "oil prices",
    "US Iran talks"
  ].map((value) => cleanText(value, 70)).filter(Boolean)));

  return terms.slice(0, 8).join(" OR ") || buildScenarioSearchQuery({ scenarios }) || "Iran";
}

function buildTavilyQueryChain({ scenarios }) {
  return Array.from(new Set([
    buildFocusedTavilyQuery({ scenarios }),
    "Iran Strait of Hormuz Gulf shipping oil prices US Iran talks",
    "Iran Hormuz oil war deal shipping",
    "Iran"
  ].map((query) => cleanText(query, 280)).filter(Boolean)));
}

async function fetchCustomTavilyArticles({ source, scenarios }) {
  const domain = source.domain || hostnameFromUrl(source.url || source.homepage);
  if (!domain) return [];

  const attempts = [];
  for (const query of buildTavilyQueryChain({ scenarios })) {
    const articles = await fetchTavilyArticles({
      query,
      domains: [domain],
      maxResults: MAX_ITEMS_PER_SOURCE,
      useDefaultDomains: false
    });

    attempts.push({ query, result_count: articles.length });
    if (!articles.length) continue;

    return articles.map((article) => ({
      ...article,
      source_id: source.id,
      source: source.name,
      source_url: source.url,
      reliability: source.reliability,
      published_at: article.published_at || article.isoDate || null,
      searchProvider: "tavily",
      tavilyQuery: query,
      tavilyQueryAttempts: attempts
    }));
  }

  console.warn("No Tavily results for custom source", { source: source.name, domain, attempts });
  return [];
}

function scoreItemAgainstSignals(item, scenario) {
  const haystack = `${item.title} ${item.snippet}`.toLowerCase();
  const matchedSignals = scenario.signals.filter((signal) => {
    const tokens = tokenise(signal);
    if (!tokens.length) return false;
    const hits = tokens.filter((token) => haystack.includes(token)).length;
    return hits >= Math.max(1, Math.ceil(tokens.length * 0.45));
  });
  return { matchedSignals, score: matchedSignals.length };
}

function scoreArticles(articles, scenarios) {
  return articles.map((article) => {
    const scenarioMatches = scenarios.map((scenario) => ({
      scenario: scenario.name,
      ...scoreItemAgainstSignals(article, scenario)
    })).filter((match) => match.score > 0);
    const totalScore = scenarioMatches.reduce((sum, match) => sum + match.score, 0);
    return { ...article, scenario_matches: scenarioMatches, total_signal_score: totalScore };
  });
}

function selectArticlesForModel(articles, scenarios, tavilySources = []) {
  const scored = scoreArticles(articles, scenarios);
  const matched = scored
    .filter((article) => article.total_signal_score > 0)
    .sort((a, b) => b.total_signal_score - a.total_signal_score || String(b.published_at || "").localeCompare(String(a.published_at || "")));

  const selectedByUrl = new Map(matched.slice(0, MAX_ITEMS_FOR_MODEL).map((article) => [article.url, article]));

  for (const source of tavilySources) {
    const alreadyHasSource = Array.from(selectedByUrl.values()).some((article) => article.source_id === source.id);
    if (alreadyHasSource) continue;

    const candidates = scored
      .filter((article) => article.source_id === source.id && article.searchProvider === "tavily")
      .slice(0, MAX_TAVILY_FALLBACK_PER_SOURCE);

    for (const candidate of candidates) {
      if (!selectedByUrl.has(candidate.url)) selectedByUrl.set(candidate.url, candidate);
    }
  }

  return Array.from(selectedByUrl.values()).slice(0, MAX_ITEMS_FOR_MODEL);
}

function heuristicAssessment(scenarios, articles, sources) {
  const sourceMap = new Map(sources.map((source) => [source.id, source]));

  return scenarios.map((scenario) => {
    const matched = new Set();
    const sourceWeights = [];
    const evidenceBySource = new Map();

    for (const article of articles) {
      const match = scoreItemAgainstSignals(article, scenario);
      if (!match.score) continue;
      match.matchedSignals.forEach((signal) => matched.add(signal));

      const source = sourceMap.get(article.source_id);
      const reliability = source?.reliability ?? article.reliability ?? 70;
      const relevance = Math.min(100, Math.round((match.score / Math.max(1, scenario.signals.length)) * 100));
      const weighting = Math.round((relevance * reliability) / 100);

      const previous = evidenceBySource.get(article.source_id) || 0;
      evidenceBySource.set(article.source_id, Math.max(previous, weighting));
      sourceWeights.push({ name: article.source, relevance_percent: relevance, reliability_percent: reliability, weighting_percent: weighting, selected: true });
    }

    const signalCoverage = Math.round((matched.size / Math.max(1, scenario.signals.length)) * 100);
    const sourceSupport = Array.from(evidenceBySource.values()).reduce((sum, value) => sum + value, 0);
    const likelihood = matched.size
      ? Math.min(100, Math.round((signalCoverage * 0.7) + (Math.min(100, sourceSupport) * 0.3)))
      : 0;

    return {
      scenario: scenario.name,
      likelihood_percent: likelihood,
      rationale: matched.size
        ? `Matched ${matched.size} of ${scenario.signals.length} user-defined signal(s) in selected sources. This score is independent, not normalized against other scenarios.`
        : "No strong signal match found in selected sources; independent likelihood is therefore low.",
      matched_signals: Array.from(matched),
      source_weights: sourceWeights.slice(0, 6)
    };
  });
}

async function callModel({ scenarios, articles, sources }) {
  if (!openai || articles.length === 0) {
    return { scenario_scores: heuristicAssessment(scenarios, articles, sources), confidence: articles.length ? "medium" : "low" };
  }

  const prompt = JSON.stringify({
    instruction: "Estimate each user-defined scenario independently from 0-100 using only the selected source articles. Do not normalize the scores and do not make them sum to 100. A single scenario should not automatically be 100%; two scenarios should not automatically be 50/50. Score each scenario by evidence strength: 0 means no meaningful evidence in the selected sources, 50 means moderate evidence, and 100 means very strong/current evidence across multiple reliable sources. Report source relevance, source reliability, and weighting for each useful source. Ignore irrelevant articles, including Tavily fallback articles that do not directly support the scenario signals. Do not invent evidence.",
    scenarios,
    selected_sources: sources.map(({ id, name, url, reliability, type, domain }) => ({ id, name, url, type, domain, reliability_percent: reliability })),
    articles: articles.map((article) => ({
      source_id: article.source_id,
      source: article.source,
      reliability_percent: article.reliability,
      title: article.title,
      snippet: article.snippet,
      url: article.url,
      published_at: article.published_at,
      search_provider: article.searchProvider,
      tavily_query: article.tavilyQuery,
      matched_before_model: article.scenario_matches
    }))
  }, null, 2);

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      scenario_scores: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            scenario: { type: "string" },
            likelihood_percent: { type: "number" },
            rationale: { type: "string" },
            matched_signals: { type: "array", items: { type: "string" } },
            source_weights: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: { type: "string" },
                  relevance_percent: { type: "number" },
                  reliability_percent: { type: "number" },
                  weighting_percent: { type: "number" },
                  selected: { type: "boolean" }
                },
                required: ["name", "relevance_percent", "reliability_percent", "weighting_percent", "selected"]
              }
            }
          },
          required: ["scenario", "likelihood_percent", "rationale", "matched_signals", "source_weights"]
        }
      }
    },
    required: ["confidence", "scenario_scores"]
  };

  const response = await Promise.race([
    openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: [
        { role: "developer", content: [{ type: "input_text", text: "Return compact JSON only. Ground every independent likelihood in the supplied article snippets and user-defined signals. Never normalize scenario scores against each other." }] },
        { role: "user", content: [{ type: "input_text", text: prompt }] }
      ],
      temperature: 0.2,
      max_output_tokens: 2200,
      text: { format: { type: "json_schema", name: "custom_scenario_assessment", schema, strict: true } }
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("OpenAI request timed out")), OPENAI_TIMEOUT_MS))
  ]);

  const output = response.output_text || response.output?.[0]?.content?.[0]?.text || "{}";
  return JSON.parse(output);
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST with scenarios and sources." });

  try {
    const { scenarios, sources } = sanitisePayload(req.body || {});
    if (!scenarios.length) {
      return sendJson(res, 400, { error: "Enter at least one scenario with at least one signal." });
    }
    if (!sources.length) {
      return sendJson(res, 400, { error: "Select at least one source." });
    }

    const failed_sources = [];
    const articles = [];
    const rssSources = sources.filter((source) => !isTavilySource(source));
    const tavilySources = sources.filter(isTavilySource);

    const feedResults = await Promise.allSettled(rssSources.map(fetchFeed));
    feedResults.forEach((result, index) => {
      if (result.status === "fulfilled") articles.push(...result.value);
      else failed_sources.push({ name: rssSources[index].name, url: rssSources[index].url, error: result.reason?.message || "Fetch failed" });
    });

    const tavilyResults = await Promise.allSettled(tavilySources.map((source) => fetchCustomTavilyArticles({ source, scenarios })));
    tavilyResults.forEach((result, index) => {
      if (result.status === "fulfilled") articles.push(...result.value);
      else failed_sources.push({ name: tavilySources[index].name, url: tavilySources[index].url, error: result.reason?.message || "Tavily search failed" });
    });

    const modelArticles = selectArticlesForModel(articles, scenarios, tavilySources);
    const tavilyArticles = articles.filter((article) => article.searchProvider === "tavily");
    const assessment = await callModel({ scenarios, articles: modelArticles, sources });

    return sendJson(res, 200, {
      assessed_at: new Date().toISOString(),
      scenario_scores: assessment.scenario_scores || [],
      confidence: assessment.confidence || "low",
      sources_used: sources.map(({ id, name, url, reliability, type, domain }) => ({ id, name, url, type, domain, reliability_percent: reliability, selected: true })),
      failed_sources,
      evidence_articles: modelArticles.map(({ source, title, url, published_at, scenario_matches, searchProvider, tavilyQuery }) => ({ source, title, url, published_at, scenario_matches, searchProvider, tavilyQuery })),
      source_diagnostics: {
        rss_source_count: rssSources.length,
        tavily_source_count: tavilySources.length,
        total_articles_collected: articles.length,
        evidence_articles_after_filter: modelArticles.length,
        tavily_articles_collected: tavilyArticles.length,
        tavily_evidence_after_filter: modelArticles.filter((article) => article.searchProvider === "tavily").length,
        tavily_fallback_per_source: MAX_TAVILY_FALLBACK_PER_SOURCE,
        tavily_query_attempts: tavilySources.map((source) => ({
          name: source.name,
          domain: source.domain,
          attempts: tavilyArticles.find((article) => article.source_id === source.id)?.tavilyQueryAttempts || []
        }))
      }
    });
  } catch (error) {
    console.error("Custom scenario assessment failed:", error);
    return sendJson(res, 500, { error: error.message || "Assessment failed" });
  }
}
