import Parser from "rss-parser";
import OpenAI from "openai";
import { buildScenarioSearchQuery, fetchTavilyArticles, hostnameFromUrl } from "./tavily-search.js";
import {
  articleAgeDays,
  evidencePagePenalty,
  qualityAdjustedMatch,
  relevanceQualityPercent
} from "./article-evidence-quality.js";

const parser = new Parser();
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const DEFAULT_SOURCES = [
  { id: "web-search", name: "Web Search", url: "https://www.google.com", homepage: "https://www.google.com", domain: "", reliability: 70, enabled: true, type: "tavily" },
  { id: "bbc-world", name: "BBC World", url: "http://feeds.bbci.co.uk/news/world/rss.xml", reliability: 82, enabled: true, type: "rss" },
  { id: "guardian-world", name: "Guardian World", url: "https://www.theguardian.com/world/rss", reliability: 78, enabled: true, type: "rss" },
  { id: "al-jazeera", name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml", reliability: 75, enabled: true, type: "rss" },
  { id: "ft-news", name: "Financial Times", url: "https://www.ft.com/news-feed?format=rss", reliability: 84, enabled: true, type: "rss" },
  { id: "google-news", name: "Google News", url: "https://news.google.com/rss?hl=en-GB&gl=GB&ceid=GB:en", reliability: 65, enabled: true, type: "rss" }
];

const MAX_SCENARIOS = 4;
const MAX_SIGNALS_PER_SCENARIO = 12;
const MAX_SOURCES = 20;
const MAX_ITEMS_PER_SOURCE = 10;
const MAX_ITEMS_FOR_MODEL = 24;
const RSS_TIMEOUT_MS = 5000;
const OPENAI_TIMEOUT_MS = 24000;
const SEARCH_PLANNER_TIMEOUT_MS = 12000;
const DEFAULT_SIGNAL_WEIGHT = 3;
const ALLOWED_SIGNAL_WEIGHTS = new Set([3, 6, 9]);

const HARD_RECENCY_LIMIT_DAYS = 90;
const FRESH_NEWS_DAYS = 30;
const RECENT_NEWS_DAYS = 60;

const LIKELIHOOD_BANDS = [
  { min: 0, max: 14, label: "remote chance" },
  { min: 15, max: 24, label: "highly unlikely" },
  { min: 25, max: 34, label: "unlikely" },
  { min: 35, max: 54, label: "realistic possibility" },
  { min: 55, max: 74, label: "likely/probably" },
  { min: 75, max: 89, label: "highly likely" },
  { min: 90, max: 100, label: "almost certain" }
];

const SUFFICIENT_EVIDENCE_THRESHOLD = {
  freshArticlesRequired: 2,
  recentArticlesRequired: 3,
  signalCoveragePercent: 20
};

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "within", "from", "that", "this",
  "scenario", "scenarios", "would", "could", "should", "about",
  "into", "over", "under", "through", "across", "after", "before",
  "during", "while", "very", "more", "less", "than", "minimal",
  "managed", "limited", "major", "minor", "likely", "unlikely",
  "possible", "current", "future", "cold", "hot", "containment",
  "collapse", "shock", "escalation", "attempt", "attempts",
  "repeated", "disrupted", "halted", "increase", "increases",
  "continue", "continues", "expand", "expands", "announced",
  "placed", "activated", "regional", "tensions", "conflict",
  "conflicts", "businesses", "volatility", "practical", "system",
  "formal", "intact", "checks", "balances", "weaken", "risk",
  "risks", "change", "changes", "uncertainty", "trend", "recent",
  "latest"
]);

const GENERIC_CONTEXT_WORDS = new Set([
  "scenario", "future", "risk", "risks", "increase", "increases",
  "decline", "declines", "weakens", "weakening", "rises", "falls",
  "major", "new", "legal", "case", "cases", "economy", "economic",
  "market", "markets", "business", "company", "companies", "support",
  "pressure", "concerns", "warning", "warnings", "crisis", "shock",
  "instability", "volatility", "current", "recent", "latest", "trend"
]);

const HARD_TOPIC_ANCHORS = {
  gulf: [
    "iran", "iranian", "hormuz", "gulf", "uae", "dubai", "emirates",
    "qatar", "oman", "saudi", "red sea", "houthi", "houthis", "tehran",
    "persian gulf", "us-iran", "u.s.-iran"
  ],
  trump: [
    "trump", "republican", "gop", "federal", "administration",
    "white house", "president", "presidential", "court", "judge",
    "agency", "agencies", "congress", "senate", "house", "executive order"
  ]
};

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

function tokenise(value) {
  return cleanText(value, 1400)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

function unique(values) {
  return Array.from(new Set((values || []).map((value) => cleanText(value, 240)).filter(Boolean)));
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function likelihoodBand(value) {
  const score = clampPercent(value);
  return LIKELIHOOD_BANDS.find((band) => score >= band.min && score <= band.max)?.label || "remote chance";
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

function canonicalUrl(value) {
  try {
    const parsed = new URL(value || "");
    parsed.protocol = "https:";
    parsed.hash = "";

    [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "t"
    ].forEach((key) => parsed.searchParams.delete(key));

    const postId = parsed.searchParams.get("post-id");
    parsed.search = postId ? `?post-id=${postId}` : "";
    parsed.hostname = parsed.hostname.replace(/^www\./, "").toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString();
  } catch {
    return cleanText(value, 500).toLowerCase();
  }
}

function parseWeightedSignal(value) {
  if (value && typeof value === "object") {
    const text = cleanText(value.text || value.name || value.signal || value.label || "", 140)
      .replace(/\s*\((3|6|9)\)\s*$/, "");
    const rawWeight = Number(value.weight ?? value.impact ?? value.score ?? DEFAULT_SIGNAL_WEIGHT);
    const weight = ALLOWED_SIGNAL_WEIGHTS.has(rawWeight) ? rawWeight : DEFAULT_SIGNAL_WEIGHT;
    return text ? { text, weight } : null;
  }

  const raw = cleanText(value, 160);
  if (!raw) return null;

  const match = raw.match(/^(.*?)\s*\((3|6|9)\)\s*$/);
  const text = cleanText(match ? match[1] : raw, 140);
  const weight = match ? Number(match[2]) : DEFAULT_SIGNAL_WEIGHT;
  return text ? { text, weight } : null;
}

function getWeightedSignals(scenario = {}) {
  const raw =
    Array.isArray(scenario.weighted_signals) && scenario.weighted_signals.length
      ? scenario.weighted_signals
      : Array.isArray(scenario.signals)
        ? scenario.signals
        : [];

  return raw.map(parseWeightedSignal).filter(Boolean);
}

function totalSignalWeight(scenario = {}) {
  return getWeightedSignals(scenario).reduce((sum, signal) => sum + signal.weight, 0) || 1;
}

function scrubImplementationDetails(value, fallback = "Not enough evidence found to support this scenario.") {
  const raw = cleanText(value, 1400);
  if (!raw) return fallback;

  const banned = [
    /\btavily\b/i,
    /\bopenai\b/i,
    /\bgpt[-\w.]*\b/i,
    /\bllm\b/i,
    /\bmodel\b/i,
    /\bfallback\b/i,
    /\bsearch provider\b/i,
    /\bapi\b/i,
    /\bbackend\b/i,
    /\bprompt\b/i,
    /\btoken\b/i,
    /\btimeout\b/i,
    /\btimed out\b/i
  ];

  return banned.some((pattern) => pattern.test(raw)) ? fallback : raw;
}

function sanitiseScenario(input, index) {
  const name = cleanText(input?.name || input?.description || `Scenario ${index + 1}`, 120);
  const description = cleanText(input?.description || input?.name || name, 600);
  const rawSignals = Array.isArray(input?.signals)
    ? input.signals
    : typeof input?.signals === "string"
      ? input.signals.split(/[\n,;]+/)
      : [];

  const weightedSignals = rawSignals
    .map(parseWeightedSignal)
    .filter(Boolean)
    .slice(0, MAX_SIGNALS_PER_SCENARIO);

  return {
    name,
    description,
    signals: weightedSignals.map((signal) => signal.text),
    weighted_signals: weightedSignals
  };
}

function isTavilySource(source = {}) {
  const type = String(source.type || "").trim().toLowerCase();
  return ["web", "site", "domain", "tavily"].includes(type);
}

function isGeneralWebSource(source = {}) {
  const id = String(source.id || "").toLowerCase();
  return id === "web-search" || id === "general-web" || id === "tavily-web";
}

function sanitiseSource(input, index) {
  const sourceId = cleanText(input?.id || `source-${index + 1}`, 80);
  const type = cleanText(input?.type || "rss", 40).toLowerCase();

  const fallbackUrl = isTavilySource({ type }) ? "https://www.google.com" : "";
  const url = normaliseUrl(input?.url || input?.homepage || input?.domain || fallbackUrl);
  if (!url) return null;

  const rawDomain = cleanText(input?.domain || "", 200);
  const domain = rawDomain
    ? hostnameFromUrl(rawDomain)
    : isGeneralWebSource({ id: sourceId, type })
      ? ""
      : hostnameFromUrl(input?.homepage || url);

  return {
    id: sourceId,
    name: cleanText(input?.name || (domain || new URL(url).hostname), 120),
    url,
    homepage: normaliseUrl(input?.homepage || url),
    domain,
    type,
    reliability: Math.max(
      0,
      Math.min(100, Number(input?.reliability ?? input?.reliability_percent ?? 70))
    ),
    enabled: input?.enabled !== false
  };
}

function sanitisePayload(body = {}) {
  const scenarios = (Array.isArray(body.scenarios) ? body.scenarios : [])
    .map(sanitiseScenario)
    .filter((scenario) => scenario.name && scenario.weighted_signals.length)
    .slice(0, MAX_SCENARIOS);

  const suppliedSources = Array.isArray(body.sources) && body.sources.length
    ? body.sources
    : DEFAULT_SOURCES;

  const sources = suppliedSources
    .map(sanitiseSource)
    .filter((source) => source && source.enabled)
    .slice(0, MAX_SOURCES);

  const hasSearchableWeb = sources.some((source) => isTavilySource(source) && isGeneralWebSource(source));

  if (!hasSearchableWeb) {
    sources.unshift(sanitiseSource(DEFAULT_SOURCES[0], 0));
  }

  return { scenarios, sources: sources.slice(0, MAX_SOURCES) };
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
      snippet: cleanText(item.contentSnippet || item.summary || item.content || "", 420),
      url: item.link || source.url,
      published_at: item.isoDate || item.pubDate || null,
      searchProvider: "rss"
    }));
  } finally {
    clear();
  }
}

function scenarioTopicText(scenarios = []) {
  return scenarios
    .flatMap((scenario) => [scenario.name, scenario.description])
    .map((value) => cleanText(value, 220))
    .filter(Boolean);
}

function scenarioSignalText(scenarios = []) {
  return scenarios
    .flatMap((scenario) => getWeightedSignals(scenario).map((signal) => signal.text))
    .map((value) => cleanText(value, 160))
    .filter(Boolean);
}

function compactKeywordQuery(values, limit = 10) {
  const counts = new Map();

  values.forEach((value) => {
    tokenise(value)
      .filter((token) => token.length > 3 && !STOP_WORDS.has(token))
      .forEach((token) => counts.set(token, (counts.get(token) || 0) + 1));
  });

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([token]) => token)
    .slice(0, limit)
    .join(" ");
}

function buildTavilyQueryChain({ scenarios }) {
  const scenarioQueries = scenarios.flatMap((scenario) => {
    const signalTerms = getWeightedSignals(scenario).map((signal) => signal.text);

    const coreQueries = [
      `${scenario.name} ${scenario.description}`,
      `${scenario.name} ${signalTerms.slice(0, 5).join(" ")}`,
      signalTerms.slice(0, 8).join(" OR "),
      compactKeywordQuery([scenario.name, scenario.description, ...signalTerms], 12)
    ];

    const evidenceBuckets = [];

    for (let i = 0; i < signalTerms.length; i += 2) {
      const chunk = signalTerms.slice(i, i + 3);
      if (chunk.length) evidenceBuckets.push(chunk.join(" OR "));
    }

    evidenceBuckets.push(
      `${scenario.name} 2026`,
      `${scenario.name} current`,
      `${scenario.name} recent`,
      `${scenario.name} trend`,
      `${scenario.description} latest`,
      scenario.description
    );

    return [...coreQueries, ...evidenceBuckets];
  });

  const topicTerms = unique(scenarioTopicText(scenarios));
  const signalTerms = unique(scenarioSignalText(scenarios));

  return unique([
    ...scenarioQueries,
    topicTerms.slice(0, 6).join(" OR "),
    compactKeywordQuery(topicTerms, 10),
    signalTerms.slice(0, 8).join(" OR "),
    compactKeywordQuery(signalTerms, 10),
    buildScenarioSearchQuery({ scenarios })
  ])
    .map((query) => cleanText(query, 280))
    .filter(Boolean);
}

function fallbackStrategicQueries(scenarios = []) {
  const text = scenarios
    .flatMap((scenario) => [
      scenario.name,
      scenario.description,
      ...getWeightedSignals(scenario).map((signal) => signal.text)
    ])
    .join(" ")
    .toLowerCase();

  const queries = [];

  const isFashionAiScenario =
  /(fashion|luxury fashion|luxury brand|lookbook|designer|creative director|campaign visuals)/.test(text)
  && /(generative ai|ai-generated|synthetic influencer|synthetic media|ai design|ai-assisted design)/.test(text)
  && !/(skincare|beauty|cosmetic|ingredient|dermatologist|anti-aging|clean beauty)/.test(text);

if (isFashionAiScenario) {
  queries.push(
    "luxury fashion generative AI design",
    "fashion brands generative AI campaign",
    "AI generated fashion campaign backlash",
    "luxury brand AI marketing campaign",
    "fashion design generative AI copyright lawsuit",
    "synthetic influencer luxury fashion campaign",
    "AI fashion design intellectual property",
    "fast fashion AI trend prediction"
  );
}

  if (/(skincare|beauty|cosmetic|ingredient)/.test(text)) {
    queries.push(
      "skincare misleading claims regulator",
      "beauty advertising standards skincare claims",
      "skincare class action lawsuit misleading claims",
      "dermatologist viral skincare trend criticism",
      "beauty brands ingredient transparency regulation"
    );
  }

  return unique(queries);
}

async function buildScenarioSearchPlan({ scenarios }) {
  const fallback = {
    planner_status: openai ? "fallback" : "no_openai_client",
    planner_error: openai ? null : "OPENAI_API_KEY is missing or OpenAI client was not initialised.",
    scenario_summary: "",
    core_topic: "",
    search_queries: unique([
      ...fallbackStrategicQueries(scenarios),
      ...buildTavilyQueryChain({ scenarios })
    ]),
    signals_to_track: unique(scenarioSignalText(scenarios)),
    entities: [],
    industries: [],
    geographies: [],
    exclude_terms: []
  };

  if (!openai) return fallback;

  const scenarioPayload = scenarios.map((scenario) => ({
    name: scenario.name,
    description: scenario.description,
    signals: getWeightedSignals(scenario)
  }));

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      scenario_summary: { type: "string" },
      core_topic: { type: "string" },
      industries: { type: "array", items: { type: "string" } },
      geographies: { type: "array", items: { type: "string" } },
      entities: { type: "array", items: { type: "string" } },
      signals_to_track: { type: "array", items: { type: "string" } },
      search_queries: { type: "array", items: { type: "string" } },
      exclude_terms: { type: "array", items: { type: "string" } }
    },
    required: [
      "scenario_summary",
      "core_topic",
      "industries",
      "geographies",
      "entities",
      "signals_to_track",
      "search_queries",
      "exclude_terms"
    ]
  };

  try {
    const response = await Promise.race([
      openai.responses.create({
        model: process.env.OPENAI_SEARCH_PLANNER_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini",
        input: [
          {
            role: "developer",
            content: [
              {
                type: "input_text",
                text: `You are a scenario research strategist.

Convert future scenario inputs into concrete article-search intelligence.

Return search queries that look like real news/search queries, not strategy workshop language.

Rules:
- Focus on concrete actors, policies, companies, technologies, markets, geographies, events and weak signals.
- Include 8-14 search_queries.
- Include 8-14 signals_to_track.
- Include named entities where useful.
- Do not invent fake citations or sources.
- Avoid generic words such as future, scenario, disruption, risk, change, uncertainty unless paired with concrete terms.
- Queries should be short and searchable, usually 4-9 words.`
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify({ scenarios: scenarioPayload }, null, 2)
              }
            ]
          }
        ],
        temperature: 0.2,
        max_output_tokens: 1600,
        text: {
          format: {
            type: "json_schema",
            name: "scenario_search_plan",
            schema,
            strict: true
          }
        }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("OpenAI search planner timed out")), SEARCH_PLANNER_TIMEOUT_MS))
    ]);


    const parsed = JSON.parse(response.output_text || response.output?.[0]?.content?.[0]?.text || "{}");

    return {
      planner_status: "ok",
      planner_error: null,
      scenario_summary: cleanText(parsed.scenario_summary, 500),
      core_topic: cleanText(parsed.core_topic, 180),
      industries: unique(parsed.industries || []).slice(0, 12),
      geographies: unique(parsed.geographies || []).slice(0, 12),
      entities: unique(parsed.entities || []).slice(0, 20),
      signals_to_track: unique(parsed.signals_to_track || []).slice(0, 16),
      search_queries: unique([
  ...fallbackStrategicQueries(scenarios),
  ...(parsed.search_queries || []),
  ...fallback.search_queries
])
  .map((query) => cleanText(query, 280))
  .filter(Boolean)
  .slice(0, 28),
      exclude_terms: unique(parsed.exclude_terms || []).slice(0, 16)
    };
  } catch (error) {
    return {
      ...fallback,
      planner_status: "failed",
      planner_error: cleanText(error?.message || String(error), 500),
      search_queries: unique([
  ...fallbackStrategicQueries(scenarios),
  ...fallback.search_queries
])
    };
  }
}

function sameOrSubdomain(child, parent) {
  const a = String(child || "").toLowerCase().replace(/^www\./, "");
  const b = String(parent || "").toLowerCase().replace(/^www\./, "");
  return Boolean(a && b && (a === b || a.endsWith(`.${b}`)));
}

function articleMatchesSourceDomain(article, source) {
  const sourceDomain = source.domain || hostnameFromUrl(source.url || source.homepage);
  const articleDomain = hostnameFromUrl(article.url);
  return Boolean(sourceDomain && articleDomain && sameOrSubdomain(articleDomain, sourceDomain));
}

function articleText(article) {
  return `${article.title || ""} ${article.snippet || article.contentSnippet || ""}`.toLowerCase();
}

function scenarioText(scenario) {
  return `${scenario.name || ""} ${scenario.description || ""} ${getWeightedSignals(scenario)
    .map((signal) => signal.text)
    .join(" ")}`.toLowerCase();
}

function scenarioAnchorTokens(scenario) {
  const weightedSignals = getWeightedSignals(scenario).map((signal) => signal.text);

  const text = [
    scenario.name || "",
    scenario.description || "",
    ...weightedSignals
  ].join(" ");

  return unique(
    tokenise(text)
      .filter((token) => token.length >= 4)
      .filter((token) => !STOP_WORDS.has(token))
      .filter((token) => !GENERIC_CONTEXT_WORDS.has(token))
  ).slice(0, 20);
}

function expandedScenarioAnchorTokens(scenario, searchPlan) {
  const base = scenarioAnchorTokens(scenario);
  const planned = [
    ...(searchPlan?.entities || []),
    ...(searchPlan?.industries || []),
    ...(searchPlan?.geographies || []),
    ...(searchPlan?.signals_to_track || [])
  ];

  return unique([
    ...base,
    ...planned.flatMap((value) =>
      tokenise(value)
        .filter((token) => token.length >= 4)
        .filter((token) => !STOP_WORDS.has(token))
        .filter((token) => !GENERIC_CONTEXT_WORDS.has(token))
    )
  ]).slice(0, 35);
}

function hasScenarioEntityOverlap(article, scenario, searchPlan = null) {
  const haystack = articleText(article);
  const provider = String(article.searchProvider || "").toLowerCase();

  const anchors = searchPlan
    ? expandedScenarioAnchorTokens(scenario, searchPlan)
    : scenarioAnchorTokens(scenario);

  const hardAnchors = hardAnchorsForScenario(scenario);
  const plannedEntities = unique([
    ...(searchPlan?.entities || []),
    ...(searchPlan?.geographies || []),
    ...(searchPlan?.industries || [])
  ])
    .flatMap((value) => tokenise(value))
    .filter((token) => token.length >= 4)
    .filter((token) => !STOP_WORDS.has(token))
    .filter((token) => !GENERIC_CONTEXT_WORDS.has(token));

  const combinedAnchors = unique([
    ...anchors,
    ...hardAnchors.flatMap((value) => tokenise(value)),
    ...plannedEntities
  ]);

  if (!combinedAnchors.length) return true;

  const hits = combinedAnchors.filter((anchor) => haystack.includes(anchor));

  if (provider === "rss") {
    return hits.length >= 2;
  }

  return hits.length >= 1;
}

function hardAnchorsForScenario(scenario) {
  const text = scenarioText(scenario);
  const anchors = [];

  if (/(iran|hormuz|gulf|uae|dubai|emirates|red sea|houthi|tehran|persian gulf|us-iran|u\.s\.-iran)/.test(text)) {
    anchors.push(...HARD_TOPIC_ANCHORS.gulf);
  }

  if (/(trump|republican|gop|federal|administration|white house|executive order|presidential)/.test(text)) {
    anchors.push(...HARD_TOPIC_ANCHORS.trump);
  }

  return unique(anchors);
}

function hasScenarioContextOverlap(article, scenario, searchPlan = null) {
  return hasScenarioEntityOverlap(article, scenario, searchPlan);
}

function hasScenarioTopicOverlap(article, scenarios, searchPlan = null) {
  return scenarios.some((scenario) => hasScenarioContextOverlap(article, scenario, searchPlan));
}

function isExcludedBySearchPlan(article, searchPlan) {
  const excludes = unique(searchPlan?.exclude_terms || []);
  if (!excludes.length) return false;

  const haystack = articleText(article);
  return excludes.some((term) => {
    const tokens = tokenise(term).filter((token) => token.length >= 4);
    return tokens.length && tokens.every((token) => haystack.includes(token));
  });
}

async function fetchCustomTavilyArticles({ source, scenarios, searchPlan, tavilyDebug = [] }) {
  const domain = source.domain || hostnameFromUrl(source.url || source.homepage);
  const useDomainRestriction = Boolean(domain && !isGeneralWebSource(source));
  if (!useDomainRestriction && !isGeneralWebSource(source)) {
    return [];
  }
  const attempts = [];
  const collected = [];

  const queries = unique([
    ...(searchPlan?.search_queries || []),
    ...buildTavilyQueryChain({ scenarios })
  ])
    .map((query) => cleanText(query, 280))
    .filter(Boolean)
    .slice(0, isGeneralWebSource(source) ? 8 : 4);

  for (const query of queries) {
    try {
      const articles = await fetchTavilyArticles({
        query,
        domains: useDomainRestriction ? [domain] : [],
        maxResults: MAX_ITEMS_PER_SOURCE,
        useDefaultDomains: !useDomainRestriction
      });

      const domainMatchedArticles = useDomainRestriction
        ? articles.filter((article) => articleMatchesSourceDomain(article, source))
        : articles;

      const relevantArticles = domainMatchedArticles
        .filter((article) => !isExcludedBySearchPlan(article, searchPlan))
        .filter((article) => hasScenarioTopicOverlap(article, scenarios, searchPlan));

      attempts.push({
        query,
        result_count: articles.length,
        domain_restricted: useDomainRestriction,
        domain: useDomainRestriction ? domain : "",
        domain_matched_count: domainMatchedArticles.length,
        relevant_count: relevantArticles.length
      });


      collected.push(...relevantArticles);
    } catch (error) {
      attempts.push({
        query,
        result_count: 0,
        domain_restricted: useDomainRestriction,
        domain: useDomainRestriction ? domain : "",
        domain_matched_count: 0,
        relevant_count: 0,
        error: cleanText(error?.message || String(error), 300)
      });
    }
  }

  tavilyDebug.push({
    source: source.name,
    source_id: source.id,
    domain: useDomainRestriction ? domain : "",
    general_web: isGeneralWebSource(source),
    attempted_query_count: attempts.length,
    collected_count: collected.length,
    attempts
  });

  return dedupeArticles(collected).slice(0, MAX_ITEMS_PER_SOURCE).map((article) => ({
    ...article,
    source_id: source.id,
    source: source.name,
    source_url: source.url,
    reliability: source.reliability,
    published_at: article.published_at || article.isoDate || null,
    searchProvider: "tavily",
    tavilyQueryAttempts: attempts
  }));
}

function extractDateFromArticleText(article) {
  const text = `${article.published_at || ""} ${article.url || ""} ${article.title || ""} ${article.snippet || ""}`;
  const match = text.match(/\b(20\d{2})[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])\b/);
  if (!match) return null;

  const parsed = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function inferredArticleAgeDays(article) {
  const directAge = articleAgeDays(article);
  if (directAge !== null) return directAge;

  const inferredDate = extractDateFromArticleText(article);
  if (!inferredDate) return null;

  return Math.max(0, Math.floor((Date.now() - inferredDate.getTime()) / 86400000));
}

function isTooOldForEvidence(article) {
  const age = inferredArticleAgeDays(article);
  if (age === null) return true;
  return age > HARD_RECENCY_LIMIT_DAYS;
}

function articleFreshnessMultiplier(article) {
  const age = inferredArticleAgeDays(article);

  if (age === null) return 0;
  if (age <= FRESH_NEWS_DAYS) return 1;
  if (age <= RECENT_NEWS_DAYS) return 0.75;
  if (age <= HARD_RECENCY_LIMIT_DAYS) return 0.4;

  return 0;
}

function isWeakEvidencePage(article) {
  return evidencePagePenalty(article) === 0;
}

function dedupeArticles(articles) {
  const byKey = new Map();

  for (const article of articles) {
    if (isWeakEvidencePage(article)) continue;
    if (isTooOldForEvidence(article)) continue;

    const key = `${canonicalUrl(article.url)}|${cleanText(article.title, 120).toLowerCase()}`;
    const existing = byKey.get(key);

    if (!existing || String(article.published_at || "") > String(existing.published_at || "")) {
      byKey.set(key, article);
    }
  }

  return Array.from(byKey.values());
}

function textHas(haystack, regex) {
  return regex.test(haystack);
}

function aliasSignalMatch(signalText, haystack) {
  const signal = signalText.toLowerCase();
  const h = haystack.toLowerCase();

  if (signal.includes("generative ai") && signal.includes("design")) {
    return textHas(h, /(generative ai|genai|artificial intelligence|ai-generated)/)
      && textHas(h, /(fashion|luxury|design|designer|creative|campaign|lookbook)/);
  }

  if (signal.includes("synthetic influencer") || signal.includes("synthetic media")) {
    return textHas(h, /(synthetic influencer|virtual influencer|digital avatar|ai influencer|synthetic media)/)
      && textHas(h, /(fashion|luxury|brand|campaign|marketing)/);
  }

  if (signal.includes("copyright") || signal.includes("ip lawsuit") || signal.includes("ip disputes")) {
    return textHas(h, /(copyright|intellectual property|ip|lawsuit|sued|legal dispute|infringement)/)
      && textHas(h, /(ai|generative|fashion|design|image|creative)/);
  }

  if (signal.includes("fast fashion") && signal.includes("ai")) {
    return textHas(h, /(fast fashion|shein|zara|h&m|asos)/)
      && textHas(h, /(ai|algorithm|trend prediction|data|automation)/);
  }

  if (signal.includes("military-protected") || signal.includes("protected shipping")) {
    return textHas(h, /(escort|patrol|protect|secure|warship|navy|naval|convoy)/)
      && textHas(h, /(shipping|tanker|vessel|hormuz|gulf)/);
  }

  if (signal.includes("us-iran") || signal.includes("negotiations")) {
    return textHas(h, /(u\.?s\.?|united states|washington|trump).{0,80}iran|iran.{0,80}(u\.?s\.?|united states|washington|trump)/)
      && textHas(h, /(talk|negotiat|deal|proposal|ceasefire|diplom|mediat)/);
  }

  if (signal.includes("red sea shipping")) {
    return textHas(h, /red sea/)
      && textHas(h, /(shipping|vessel|tanker|attack|houthi|rerout|suspend|halt|disrupt)/);
  }

  if (signal.includes("hormuz")) {
    return textHas(h, /hormuz/)
      && textHas(h, /(strait|shipping|tanker|vessel|closure|blockade|security|incident|attack|escort|protect|reopen|patrol)/);
  }

  if (signal.includes("oil price")) {
    return textHas(h, /oil/)
      && textHas(h, /price|brent|crude|barrel|energy/)
      && textHas(h, /(rise|drop|surge|fall|volatile|jump|spike|soar|tumble|climb)/);
  }

  if (signal.includes("insurance") || signal.includes("freight rates")) {
    return textHas(h, /(insurance|premium|premiums|freight|shipping cost|rates|longer route|more expensive|rerout)/)
      && textHas(h, /(gulf|hormuz|shipping|tanker|vessel|route|trade)/);
  }

  if (signal.includes("airspace")) {
    return textHas(h, /(airspace|flight ban|closed air|air corridors|airport closure)/)
      && textHas(h, /(regional|gulf|iran|uae|dubai|emirates)/);
  }

  if (signal.includes("energy infrastructure")) {
    return textHas(h, /(oil facility|energy infrastructure|refinery|pipeline|power plant|production facility|alert|high alert)/)
      && textHas(h, /(iran|gulf|uae|hormuz|energy|oil)/);
  }

  if (signal.includes("business continuity") || signal.includes("contingency")) {
    return textHas(h, /(uae|dubai|emirates|gcc)/)
      && textHas(h, /(contingency|business continuity|emergency|continuity|preparedness|activated)/);
  }

  if (signal.includes("tourism")) {
    return textHas(h, /(tourism|tourist|bookings|hotel|travel|visitor|flight|airport)/)
      && textHas(h, /(decline|drop|cancel|fall|slowdown|plunge)/);
  }

  if (signal.includes("critical infrastructure")) {
    return textHas(h, /(infrastructure|oil facility|refinery|pipeline|power plant|port|airport)/)
      && textHas(h, /(strike|attack|hit|damage|target)/);
  }

  if (signal.includes("supply chain") || signal.includes("rerouting")) {
    return textHas(h, /(rerout|alternative corridor|alternate route|around africa|suez|supply chain|shipping route)/);
  }

  if (signal.includes("banks warn")) {
    return textHas(h, /bank/) && textHas(h, /(warn|risk|exposure|geopolitical)/);
  }

  if (signal.includes("legal exposure")) {
    return textHas(h, /(lawsuit|sued|legal challenge|investigation|criminal|civil case|indictment)/);
  }

  if (signal.includes("court rulings") || signal.includes("courts")) {
    return textHas(h, /(court|judge|ruling|injunction|blocked|block|supreme court)/);
  }

  if (signal.includes("republican") && signal.includes("break")) {
    return textHas(h, /(republican|gop)/)
      && textHas(h, /(break with|oppose|defect|criticiz|rebuke|split)/);
  }

  if (signal.includes("republican") && signal.includes("support")) {
    return textHas(h, /(republican|gop)/)
      && textHas(h, /(support|back|backing|endorse|align)/);
  }

  if (signal.includes("executive orders")) {
    return textHas(h, /(executive order|presidential authority|presidential power|exceeds presidential|expand authority)/);
  }

  if (signal.includes("loyalist")) {
    return textHas(h, /(loyalist|ally|allies|appoint|installed|nomination|loyal)/)
      && textHas(h, /(agency|federal|administration|department)/);
  }

  return false;
}

function scoreItemAgainstSignals(item, scenario, searchPlan = null) {
  const haystack = articleText(item);
  const matchedSignals = [];
  let weightedScore = 0;

  if (!hasScenarioEntityOverlap(item, scenario, searchPlan)) {
    return { matchedSignals, score: 0, weightedScore: 0 };
  }

  const searchPlanSignals = unique(searchPlan?.signals_to_track || []).map((text) => ({
    text,
    weight: DEFAULT_SIGNAL_WEIGHT
  }));

  const signals = unique([
    ...getWeightedSignals(scenario).map((signal) => JSON.stringify(signal)),
    ...searchPlanSignals.map((signal) => JSON.stringify(signal))
  ]).map((value) => JSON.parse(value));

  for (const signal of signals) {
    const tokens = tokenise(signal.text)
      .filter((token) => !STOP_WORDS.has(token))
      .filter((token) => ![
        "state", "states", "national", "nationally", "support",
        "loss", "falls", "fall", "gain", "gains", "lead", "leads",
        "court", "ruling", "new", "major", "security", "incident",
        "incidents", "regional", "business", "businesses", "costs",
        "price", "prices"
      ].includes(token));

    const hits = tokens.filter((token) => haystack.includes(token)).length;

    const tokenMatch =
      tokens.length <= 2
        ? hits === tokens.length
        : hits >= Math.min(2, tokens.length);

    if (aliasSignalMatch(signal.text, haystack) || tokenMatch) {
      matchedSignals.push(signal.text);
      weightedScore += signal.weight;
    }
  }

  return { matchedSignals: unique(matchedSignals), score: weightedScore, weightedScore };
}

function hasStrongRssTopicMatch(article, scenario, searchPlan = null) {
  const haystack = articleText(article);

  const scenarioTokens = tokenise(`${scenario.name} ${scenario.description}`)
    .filter((token) => token.length >= 5)
    .filter((token) => !STOP_WORDS.has(token))
    .filter((token) => !GENERIC_CONTEXT_WORDS.has(token));

  const entityTokens = unique([
    ...(searchPlan?.entities || []),
    ...(searchPlan?.geographies || []),
    ...(searchPlan?.industries || [])
  ])
    .flatMap((value) => tokenise(value))
    .filter((token) => token.length >= 5)
    .filter((token) => !STOP_WORDS.has(token))
    .filter((token) => !GENERIC_CONTEXT_WORDS.has(token));

  const signalTokens = unique(searchPlan?.signals_to_track || [])
    .flatMap((value) => tokenise(value))
    .filter((token) => token.length >= 6)
    .filter((token) => !STOP_WORDS.has(token))
    .filter((token) => !GENERIC_CONTEXT_WORDS.has(token));

  const scenarioHits = scenarioTokens.filter((token) => haystack.includes(token)).length;
  const entityHits = entityTokens.filter((token) => haystack.includes(token)).length;
  const signalHits = signalTokens.filter((token) => haystack.includes(token)).length;

  const scenarioName = String(scenario.name || "").toLowerCase();

  if (scenarioName.includes("gulf")) {
    return /(gulf|hormuz|uae|dubai|abu dhabi|kuwait|bahrain|iran|shipping|airspace|oil|tanker)/.test(haystack)
      && (entityHits >= 1 || signalHits >= 2);
  }

  if (scenarioName.includes("executive")) {
    return /(trump|white house|president|federal|supreme court|congress|senate|agency|executive order|justice department|homeland security)/.test(haystack)
      && (entityHits >= 1 || signalHits >= 2);
  }

  if (scenarioName.includes("creative") || scenarioName.includes("fashion")) {
    return /(fashion|luxury|brand|gucci|lvmh|dior|prada|burberry|zara|shein|adobe|ai|generative)/.test(haystack)
      && (entityHits >= 1 || signalHits >= 2);
  }

  if (scenarioName.includes("ingredient") || scenarioName.includes("skincare")) {
    return /(skincare|beauty|cosmetic|dermatologist|ingredient|fda|ftc|asa|sephora|ulta|cerave)/.test(haystack)
      && (entityHits >= 1 || signalHits >= 2);
  }

  return scenarioHits >= 2 && (entityHits >= 1 || signalHits >= 2);
}

function scoreArticles(articles, scenarios, searchPlan = null) {
  return dedupeArticles(articles).map((article) => {
    const scenarioMatches = scenarios
      .map((scenario) => {
        const rawMatch = scoreItemAgainstSignals(article, scenario, searchPlan);
        const contextMatched = hasScenarioContextOverlap(article, scenario, searchPlan);

        const adjustedMatch = qualityAdjustedMatch(
          article,
          rawMatch,
          totalSignalWeight(scenario)
        );

        const provider = String(article.searchProvider || "").toLowerCase();
        const rssStrongEnough = provider !== "rss" || hasStrongRssTopicMatch(article, scenario, searchPlan);

        const evidenceGatePassed =
          adjustedMatch.score > 0
          && contextMatched
          && rssStrongEnough
          && adjustedMatch.relevance_quality_percent >= 5
          && !isTooOldForEvidence(article);

        return {
          scenario: scenario.name,
          ...adjustedMatch,
          contextMatched,
          evidenceGatePassed
        };
      })
      .filter((match) => match.evidenceGatePassed);

    const totalScore = scenarioMatches.reduce((sum, match) => sum + match.score, 0);

    return {
      ...article,
      article_age_days: inferredArticleAgeDays(article),
      freshness_multiplier: articleFreshnessMultiplier(article),
      scenario_matches: scenarioMatches,
      total_signal_score: totalScore
    };
  });
}

function selectArticlesForModel(articles, scenarios, searchPlan = null) {
  return scoreArticles(articles, scenarios, searchPlan)
    .filter((article) => article.total_signal_score > 0)
    .sort((a, b) =>
      b.freshness_multiplier - a.freshness_multiplier
      || b.total_signal_score - a.total_signal_score
      || String(b.published_at || "").localeCompare(String(a.published_at || ""))
    )
    .slice(0, MAX_ITEMS_FOR_MODEL);
}

function computeSourceWeightsForScenario(articles, scenario, sources) {
  const maxWeight = totalSignalWeight(scenario);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const bySource = new Map();

  for (const article of articles) {
    const match = article.scenario_matches?.find((item) => item.scenario === scenario.name);
    if (!match || !match.score) continue;

    const source = sourceById.get(article.source_id) || {};
    const reliability = Math.max(0, Math.min(100, Number(source.reliability ?? article.reliability ?? 70)));

    const relevance = relevanceQualityPercent({
      article,
      match,
      maxWeight
    });

    const weighting = Math.round((relevance * reliability) / 100);
    const existing = bySource.get(article.source_id);

    if (!existing || weighting > existing.weighting_percent) {
      bySource.set(article.source_id, {
        name: article.source || source.name || "Unknown source",
        relevance_percent: relevance,
        reliability_percent: reliability,
        weighting_percent: weighting,
        selected: true
      });
    }
  }

  return Array.from(bySource.values())
    .sort((a, b) => b.weighting_percent - a.weighting_percent || b.relevance_percent - a.relevance_percent)
    .slice(0, 8);
}

function getMatchedSignalsFromArticles(articles, scenario) {
  const matched = new Set();

  for (const article of articles) {
    const match = article.scenario_matches?.find((item) => item.scenario === scenario.name);
    if (!match || match.score <= 0) continue;

    (match?.matchedSignals || []).forEach((signal) => matched.add(signal));
  }

  return Array.from(matched);
}

function hasEnoughEvidence(freshArticleCount, recentArticleCount, signalCoveragePercent) {
  return freshArticleCount >= SUFFICIENT_EVIDENCE_THRESHOLD.freshArticlesRequired
    || recentArticleCount >= SUFFICIENT_EVIDENCE_THRESHOLD.recentArticlesRequired
    || signalCoveragePercent >= SUFFICIENT_EVIDENCE_THRESHOLD.signalCoveragePercent;
}

function computeScoreCalibrationForScenario(articles, scenario, sources) {
  const sourceWeights = computeSourceWeightsForScenario(articles, scenario, sources);
  const matchedSignals = getMatchedSignalsFromArticles(articles, scenario);
  const maxWeight = totalSignalWeight(scenario);

  const matchedWeight = getWeightedSignals(scenario).reduce((sum, signal) => {
    const bestSignalScore = articles.reduce((best, article) => {
      const match = article.scenario_matches?.find((item) => item.scenario === scenario.name);
      if (!match?.matchedSignals?.includes(signal.text)) return best;

      const quality = Math.max(0, Math.min(1, Number(match.relevance_quality_percent || 0) / 100));
      const adjusted = Math.round(signal.weight * quality);

      return Math.max(best, adjusted);
    }, 0);

    return sum + bestSignalScore;
  }, 0);

  const weightedSignalCoverage = Math.round((matchedWeight / maxWeight) * 100);
  const sourceSupport = Math.min(100, sourceWeights.reduce((sum, source) => sum + source.weighting_percent, 0));
  const sourceDiversity = Math.min(100, sourceWeights.length * 20);

  const freshArticleCount = articles.filter((article) => {
    const age = articleAgeDays(article);
    return article.scenario_matches?.some((item) => item.scenario === scenario.name)
      && age !== null
      && age <= FRESH_NEWS_DAYS;
  }).length;

  const recentArticleCount = articles.filter((article) => {
    const age = articleAgeDays(article);
    return article.scenario_matches?.some((item) => item.scenario === scenario.name)
      && age !== null
      && age <= HARD_RECENCY_LIMIT_DAYS;
  }).length;

  const sufficientEvidence = hasEnoughEvidence(freshArticleCount, recentArticleCount, weightedSignalCoverage);

  let calibratedLikelihood;
  let likelihoodBandLabel;
  let evidenceStatus = "sufficient";

  if (!sufficientEvidence) {
    calibratedLikelihood = null;
    likelihoodBandLabel = "insufficient evidence";
    evidenceStatus = "insufficient";
  } else {
    calibratedLikelihood = matchedSignals.length
      ? clampPercent((weightedSignalCoverage * 0.82) + (sourceSupport * 0.12) + (sourceDiversity * 0.06))
      : 0;

    if (recentArticleCount < 2) {
      calibratedLikelihood = Math.min(calibratedLikelihood, 34);
    } else if (freshArticleCount < 2) {
      calibratedLikelihood = Math.min(calibratedLikelihood, 54);
    }

    likelihoodBandLabel = likelihoodBand(calibratedLikelihood);
  }

  return {
    calibratedLikelihood,
    likelihoodBand: likelihoodBandLabel,
    matchedSignals,
    matchedWeight,
    maxWeight,
    weightedSignalCoverage,
    sourceSupport,
    sourceDiversity,
    sourceWeights,
    freshArticleCount,
    recentArticleCount,
    sufficientEvidence,
    evidenceStatus
  };
}

function deterministicAssessment(scenarios, articles, sources) {
  return scenarios.map((scenario) => {
    const c = computeScoreCalibrationForScenario(articles, scenario, sources);

    let rationale;
    if (!c.sufficientEvidence) {
      rationale = "Not enough evidence found to assess this scenario. Selected sources did not provide sufficient coverage of the signals you specified.";
    } else if (c.matchedSignals.length) {
      rationale = `Matched recent weighted evidence worth ${c.matchedWeight} of ${c.maxWeight} available impact points across selected sources, placing this scenario in the ${c.likelihoodBand} band.`;
    } else {
      rationale = "Not enough evidence found to support this scenario.";
    }

    return {
      scenario: scenario.name,
      likelihood_percent: c.calibratedLikelihood,
      likelihood_band: c.likelihoodBand,
      rationale,
      matched_signals: c.matchedSignals,
      source_weights: c.sourceWeights,
      evidence_status: c.evidenceStatus,
      score_calibration: {
        weighted_signal_coverage_percent: c.weightedSignalCoverage,
        matched_signal_weight: c.matchedWeight,
        total_signal_weight: c.maxWeight,
        source_support_percent: c.sourceSupport,
        source_diversity_percent: c.sourceDiversity,
        fresh_article_count: c.freshArticleCount,
        recent_article_count: c.recentArticleCount,
        calibrated_likelihood_percent: c.calibratedLikelihood,
        sufficient_evidence: c.sufficientEvidence
      }
    };
  });
}

function mergeModelRationales(assessment = {}, scenarios = [], articles = [], sources = []) {
  const deterministic = deterministicAssessment(scenarios, articles, sources);
  const byScenario = new Map((assessment.scenario_scores || []).map((score) => [score.scenario, score]));

  return {
    confidence: assessment.confidence || (articles.length ? "medium" : "low"),
    scenario_scores: deterministic.map((score) => ({
      ...score,
      model_likelihood_percent: score.likelihood_percent === null ? null : clampPercent(byScenario.get(score.scenario)?.likelihood_percent),
      rationale: scrubImplementationDetails(byScenario.get(score.scenario)?.rationale || score.rationale)
    }))
  };
}

async function callModel({ scenarios, articles, sources }) {
  if (!openai || !articles.length) {
    return {
      confidence: articles.length ? "medium" : "low",
      scenario_scores: deterministicAssessment(scenarios, articles, sources)
    };
  }

  const deterministic = deterministicAssessment(scenarios, articles, sources);

  const prompt = JSON.stringify({
    instruction:
      "Explain each scenario using only the selected source articles. Do not recalculate or change likelihood percentages, likelihood bands, matched signals, or source weights; use the supplied deterministic assessment as fixed. Never mention implementation details. If evidence is weak or absent, say 'Not enough evidence found to support this scenario.'",
    likelihood_boundaries: LIKELIHOOD_BANDS,
    deterministic_assessment: deterministic,
    scenarios: scenarios.map((scenario) => ({
      name: scenario.name,
      description: scenario.description,
      signals: getWeightedSignals(scenario),
      total_signal_weight: totalSignalWeight(scenario)
    })),
    articles: articles.map((article) => ({
      source: article.source,
      title: article.title,
      snippet: article.snippet,
      url: article.url,
      published_at: article.published_at,
      article_age_days: article.article_age_days,
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
            likelihood_percent: { type: ["number", "null"] },
            likelihood_band: { type: "string" },
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
                required: [
                  "name",
                  "relevance_percent",
                  "reliability_percent",
                  "weighting_percent",
                  "selected"
                ]
              }
            }
          },
          required: [
            "scenario",
            "likelihood_percent",
            "likelihood_band",
            "rationale",
            "matched_signals",
            "source_weights"
          ]
        }
      }
    },
    required: ["confidence", "scenario_scores"]
  };

  try {
    const response = await Promise.race([
      openai.responses.create({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        input: [
          {
            role: "developer",
            content: [
              {
                type: "input_text",
                text: "Return compact JSON only. Keep likelihoods, bands, matched signals, and source weights fixed from the deterministic assessment. Only improve rationales."
              }
            ]
          },
          {
            role: "user",
            content: [{ type: "input_text", text: prompt }]
          }
        ],
        temperature: 0.2,
        max_output_tokens: 2200,
        text: {
          format: {
            type: "json_schema",
            name: "custom_scenario_assessment",
            schema,
            strict: true
          }
        }
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("OpenAI request timed out")), OPENAI_TIMEOUT_MS))
    ]);

    const output = response.output_text || response.output?.[0]?.content?.[0]?.text || "{}";
    return mergeModelRationales(JSON.parse(output), scenarios, articles, sources);
  } catch {
    return {
      confidence: "medium",
      scenario_scores: deterministic
    };
  }
}


export default async function handler(req, res) {
  const tavilyDebug = [];
  setCors(res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });

  const { scenarios, sources } = sanitisePayload(req.body || {});

  if (!scenarios.length) {
    return sendJson(res, 400, { error: "At least one scenario with signals is required." });
  }

  const searchPlan = await buildScenarioSearchPlan({ scenarios });

  const rssResults = await Promise.allSettled(sources.map(fetchFeed));
const tavilySources = sources.filter(isTavilySource);

const tavilyResults = await Promise.allSettled(
  tavilySources.map(async (source) => {
    try {
      return await fetchCustomTavilyArticles({
        source,
        scenarios,
        searchPlan,
        tavilyDebug
      });
    } catch (error) {
      tavilyDebug.push({
        source: source.name,
        source_id: source.id,
        domain: source.domain || "",
        general_web: isGeneralWebSource(source),
        fatal_error: cleanText(error?.message || String(error), 500),
        attempts: []
      });
      return [];
    }
  })
);

  const allArticles = [...rssResults, ...tavilyResults]
    .flatMap((result) => result.status === "fulfilled" ? result.value : []);

  const selectedArticles = selectArticlesForModel(allArticles, scenarios, searchPlan);
  const assessment = await callModel({ scenarios, articles: selectedArticles, sources });

  return sendJson(res, 200, {
    ...assessment,
    articles: selectedArticles,
    evidence_articles: selectedArticles,
    selected_articles: selectedArticles,
    debug: {
      search_plan: searchPlan,
      source_count: sources.length,
      sources_used: sources.map((source) => ({
        id: source.id,
        name: source.name,
        type: source.type,
        domain: source.domain || "",
        searchable: isTavilySource(source),
        general_web: isGeneralWebSource(source)
      })),
      tavily_source_count: tavilySources.length,
      fetched_article_count: allArticles.length,
      selected_article_count: selectedArticles.length,
      tavily_attempts: tavilyDebug,
      fetched_titles: allArticles.slice(0, 30).map((article) => ({
        source: article.source,
        provider: article.searchProvider,
        title: article.title,
        url: article.url,
        published_at: article.published_at,
        inferred_age_days: inferredArticleAgeDays(article),
        weak_page: isWeakEvidencePage(article),
        too_old: isTooOldForEvidence(article)
      })),
      selected_titles: selectedArticles.map((article) => ({
        source: article.source,
        provider: article.searchProvider,
        title: article.title,
        url: article.url,
        article_age_days: article.article_age_days,
        score: article.total_signal_score,
        scenario_matches: article.scenario_matches
      }))
    }
  });
}