import Parser from "rss-parser";
import OpenAI from "openai";
import { buildScenarioSearchQuery, fetchTavilyArticles, hostnameFromUrl } from "../lib/tavily-search.js";

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
const ALLOWED_SIGNAL_WEIGHTS = new Set([3, 6, 9]);
const DEFAULT_SIGNAL_WEIGHT = 3;
const MIN_CONTEXTLESS_SIGNAL_WEIGHT = 9;
const MAX_MODEL_SCORE_ABOVE_CALIBRATION = 0;

const LIKELIHOOD_BANDS = [
  { min: 0, max: 14, label: "remote chance" },
  { min: 15, max: 24, label: "highly unlikely" },
  { min: 25, max: 34, label: "unlikely" },
  { min: 35, max: 54, label: "realistic possibility" },
  { min: 55, max: 74, label: "likely/probably" },
  { min: 75, max: 89, label: "highly likely" },
  { min: 90, max: 100, label: "almost certain" }
];

const CONTEXT_STOP_WORDS = new Set([
  "the", "and", "for", "with", "within", "from", "that", "this", "scenario", "scenarios", "would", "could", "should", "about", "into", "over", "under", "through", "across", "after", "before", "during", "while", "very", "more", "less", "than", "minimal", "managed", "limited", "major", "minor", "likely", "unlikely", "possible", "current", "future", "cold", "hot", "containment", "collapse", "shock", "escalation"
]);

const SIGNAL_QUERY_STOP_WORDS = new Set([...CONTEXT_STOP_WORDS, "attempt", "attempts", "repeated", "disrupted", "halted", "increase", "increases", "continue", "continues", "expand", "expands", "announced", "placed", "activated"]);

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

function unique(values) {
  return Array.from(new Set(values.map((value) => cleanText(value, 180)).filter(Boolean)));
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

function parseWeightedSignal(value) {
  if (value && typeof value === "object") {
    const text = cleanText(value.text || value.name || value.signal || value.label || "", 140).replace(/\s*\((3|6|9)\)\s*$/, "");
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
  if (Array.isArray(scenario.weighted_signals) && scenario.weighted_signals.length) {
    return scenario.weighted_signals.map(parseWeightedSignal).filter(Boolean);
  }
  return (Array.isArray(scenario.signals) ? scenario.signals : []).map(parseWeightedSignal).filter(Boolean);
}

function totalSignalWeight(scenario = {}) {
  return getWeightedSignals(scenario).reduce((sum, signal) => sum + signal.weight, 0) || 1;
}

function containsImplementationDetails(value) {
  return [
    /\btavily\b/i,
    /\bopenai\b/i,
    /\bgpt[-\w.]*\b/i,
    /\bllm\b/i,
    /\bai\b/i,
    /\bmodel\b/i,
    /\bfallback\b/i,
    /\bsearch provider\b/i,
    /\bsearch_provider\b/i,
    /\brss parser\b/i,
    /\bapi\b/i,
    /\bbackend\b/i,
    /\bprompt\b/i,
    /\btoken\b/i,
    /\btimeout\b/i,
    /\btimed out\b/i
  ].some((pattern) => pattern.test(value));
}

function scrubImplementationDetails(value, fallback = "Not enough evidence found to support this scenario.") {
  const raw = cleanText(value, 1400);
  if (!raw) return fallback;
  if (containsImplementationDetails(raw)) return fallback;
  return raw
    .replace(/\bTavily\b/gi, "the selected sources")
    .replace(/\bOpenAI\b/gi, "the assessment")
    .replace(/\bGPT[-\w.]*\b/gi, "the assessment")
    .replace(/\bLLM\b/gi, "the assessment")
    .replace(/\bAI\b/gi, "the assessment")
    .replace(/\bmodel\b/gi, "assessment")
    .replace(/\bfallback\b/gi, "available")
    .replace(/\bsearch provider\b/gi, "source")
    .replace(/\bAPI\b/g, "source")
    .replace(/\bbackend\b/gi, "source system")
    .replace(/\bprompt\b/gi, "evidence set")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitiseScenario(input, index) {
  const name = cleanText(input?.name || input?.description || `Scenario ${index + 1}`, 120);
  const description = cleanText(input?.description || input?.name || name, 500);
  const rawSignals = Array.isArray(input?.signals)
    ? input.signals
    : typeof input?.signals === "string"
      ? input.signals.split(/[\n,;]+/)
      : [];
  const weightedSignals = rawSignals.map(parseWeightedSignal).filter(Boolean).slice(0, MAX_SIGNALS_PER_SCENARIO);
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
    .filter((scenario) => scenario.name && scenario.weighted_signals.length)
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

function getScenarioTopicText(scenarios = []) {
  return scenarios.flatMap((scenario) => [scenario.name, scenario.description]).map((value) => cleanText(value, 180)).filter(Boolean);
}

function getScenarioSignalText(scenarios = []) {
  return scenarios.flatMap((scenario) => getWeightedSignals(scenario).map((signal) => signal.text)).map((value) => cleanText(value, 140)).filter(Boolean);
}

function getScenarioSearchText(scenarios = []) {
  return unique([...getScenarioTopicText(scenarios), ...getScenarioSignalText(scenarios)]);
}

function getScenarioContextTokens(scenario = {}) {
  return [scenario.name, scenario.description]
    .flatMap(tokenise)
    .filter((token) => token.length > 3 && !CONTEXT_STOP_WORDS.has(token));
}

function hasScenarioContextOverlap(article, scenario) {
  const tokens = getScenarioContextTokens(scenario);
  if (!tokens.length) return true;
  const haystack = `${article.title || ""} ${article.snippet || article.contentSnippet || ""}`.toLowerCase();
  return tokens.some((token) => haystack.includes(token));
}

function sameOrSubdomain(child, parent) {
  const a = String(child || "").toLowerCase().replace(/^www\./, "");
  const b = String(parent || "").toLowerCase().replace(/^www\./, "");
  return Boolean(a && b && (a === b || a.endsWith(`.${b}`)));
}

function articleMatchesSourceDomain(article, source) {
  const sourceDomain = source.domain || hostnameFromUrl(source.url || source.homepage);
  const articleDomain = hostnameFromUrl(article.url);
  if (!sourceDomain || !articleDomain) return false;
  return sameOrSubdomain(articleDomain, sourceDomain);
}

function compactKeywordQuery(values, stopWords, limit = 10) {
  const counts = new Map();
  values.forEach((value) => {
    tokenise(value)
      .filter((token) => token.length > 3 && !stopWords.has(token))
      .forEach((token) => counts.set(token, (counts.get(token) || 0) + 1));
  });
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([token]) => token)
    .slice(0, limit)
    .join(" ");
}

function buildTopicContextQuery({ scenarios }) {
  const topicTerms = unique(getScenarioTopicText(scenarios));
  const compactTopic = compactKeywordQuery(topicTerms, CONTEXT_STOP_WORDS, 10);
  return unique([topicTerms.slice(0, 6).join(" OR "), compactTopic]).filter(Boolean);
}

function buildSignalQuery({ scenarios }) {
  const signalTerms = unique(getScenarioSignalText(scenarios));
  const compactSignals = compactKeywordQuery(signalTerms, SIGNAL_QUERY_STOP_WORDS, 10);
  return unique([signalTerms.slice(0, 8).join(" OR "), compactSignals]).filter(Boolean);
}

function buildTavilyQueryChain({ scenarios }) {
  const topicQueries = buildTopicContextQuery({ scenarios });
  const signalQueries = buildSignalQuery({ scenarios });
  const legacyQuery = buildScenarioSearchQuery({ scenarios });
  return unique([
    ...topicQueries,
    ...signalQueries,
    legacyQuery,
    scenarios.map((scenario) => scenario.name).filter(Boolean).join(" OR "),
    scenarios.map((scenario) => scenario.description).filter(Boolean).join(" OR ")
  ]).map((query) => cleanText(query, 280)).filter(Boolean);
}

function hasScenarioTopicOverlap(article, scenarios) {
  const haystack = `${article.title || ""} ${article.snippet || article.contentSnippet || ""}`.toLowerCase();
  const tokens = new Set(getScenarioSearchText(scenarios).flatMap(tokenise).filter((token) => token.length > 3));
  if (!tokens.size) return false;
  return Array.from(tokens).some((token) => haystack.includes(token));
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
    const domainMatchedArticles = articles.filter((article) => articleMatchesSourceDomain(article, source));
    const relevantArticles = domainMatchedArticles.filter((article) => hasScenarioTopicOverlap(article, scenarios));
    attempts.push({ query, result_count: articles.length, domain_matched_count: domainMatchedArticles.length, relevant_count: relevantArticles.length });
    if (!relevantArticles.length) continue;
    return relevantArticles.map((article) => ({
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
  console.warn("No relevant web results for custom source", { source: source.name, domain, attempts });
  return [];
}

function scoreItemAgainstSignals(item, scenario) {
  const haystack = `${item.title} ${item.snippet}`.toLowerCase();
  const matchedSignals = [];
  let weightedScore = 0;
  for (const signal of getWeightedSignals(scenario)) {
    const tokens = tokenise(signal.text);
    if (!tokens.length) continue;
    const hits = tokens.filter((token) => haystack.includes(token)).length;
    if (hits >= Math.max(1, Math.ceil(tokens.length * 0.45))) {
      matchedSignals.push(signal.text);
      weightedScore += signal.weight;
    }
  }
  return { matchedSignals, score: weightedScore, weightedScore };
}

function scoreArticles(articles, scenarios) {
  return articles.map((article) => {
    const scenarioMatches = scenarios.map((scenario) => {
      const match = scoreItemAgainstSignals(article, scenario);
      const contextMatched = hasScenarioContextOverlap(article, scenario);
      const evidenceGatePassed = match.score >= MIN_CONTEXTLESS_SIGNAL_WEIGHT || (match.score > 0 && contextMatched);
      return { scenario: scenario.name, ...match, contextMatched, evidenceGatePassed };
    }).filter((match) => match.score > 0 && match.evidenceGatePassed);
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
      .filter((article) => article.total_signal_score > 0)
      .slice(0, MAX_TAVILY_FALLBACK_PER_SOURCE);
    for (const candidate of candidates) {
      if (!selectedByUrl.has(candidate.url)) selectedByUrl.set(candidate.url, candidate);
    }
  }
  return Array.from(selectedByUrl.values()).slice(0, MAX_ITEMS_FOR_MODEL);
}

function computeSourceWeightsForScenario(articles, scenario, sources) {
  const maxWeight = totalSignalWeight(scenario);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const bySource = new Map();
  for (const article of articles) {
    const match = Array.isArray(article.scenario_matches) ? article.scenario_matches.find((item) => item.scenario === scenario.name) : null;
    if (!match || !match.score) continue;
    const source = sourceById.get(article.source_id) || {};
    const name = article.source || source.name || "Unknown source";
    const reliability = Math.max(0, Math.min(100, Number(source.reliability ?? article.reliability ?? 70)));
    const relevance = Math.min(100, Math.round((Number(match.score) / maxWeight) * 100));
    const weighting = Math.round((relevance * reliability) / 100);
    const existing = bySource.get(article.source_id);
    if (!existing || weighting > existing.weighting_percent) {
      bySource.set(article.source_id, { name, relevance_percent: relevance, reliability_percent: reliability, weighting_percent: weighting, selected: true });
    }
  }
  return Array.from(bySource.values()).sort((a, b) => b.weighting_percent - a.weighting_percent || b.relevance_percent - a.relevance_percent).slice(0, 8);
}

function getMatchedSignalsFromArticles(articles, scenario) {
  const matched = new Set();
  for (const article of articles) {
    const match = Array.isArray(article.scenario_matches) ? article.scenario_matches.find((item) => item.scenario === scenario.name) : null;
    if (!match) continue;
    (match.matchedSignals || []).forEach((signal) => matched.add(signal));
  }
  return Array.from(matched);
}

function computeScoreCalibrationForScenario(articles, scenario, sources) {
  const sourceWeights = computeSourceWeightsForScenario(articles, scenario, sources);
  const matchedSignals = getMatchedSignalsFromArticles(articles, scenario);
  const maxWeight = totalSignalWeight(scenario);
  const matchedWeight = getWeightedSignals(scenario).filter((signal) => matchedSignals.includes(signal.text)).reduce((sum, signal) => sum + signal.weight, 0);
  const weightedSignalCoverage = Math.round((matchedWeight / maxWeight) * 100);
  const sourceSupport = Math.min(100, sourceWeights.reduce((sum, source) => sum + source.weighting_percent, 0));
  const sourceDiversity = Math.min(100, sourceWeights.length * 20);
  const calibratedLikelihood = matchedSignals.length
    ? clampPercent((weightedSignalCoverage * 0.88) + (sourceSupport * 0.07) + (sourceDiversity * 0.05))
    : 0;
  return {
    calibratedLikelihood,
    likelihoodBand: likelihoodBand(calibratedLikelihood),
    matchedSignals,
    matchedWeight,
    maxWeight,
    weightedSignalCoverage,
    sourceSupport,
    sourceDiversity,
    sourceWeights
  };
}

function heuristicAssessment(scenarios, articles, sources) {
  return scenarios.map((scenario) => {
    const calibration = computeScoreCalibrationForScenario(articles, scenario, sources);
    return {
      scenario: scenario.name,
      likelihood_percent: calibration.calibratedLikelihood,
      likelihood_band: calibration.likelihoodBand,
      rationale: calibration.matchedSignals.length
        ? `Matched weighted signals worth ${calibration.matchedWeight} of ${calibration.maxWeight} available impact points in selected sources. This is a ${calibration.likelihoodBand} based on the supplied evidence.`
        : "Not enough evidence found to support this scenario.",
      matched_signals: calibration.matchedSignals,
      source_weights: calibration.sourceWeights
    };
  });
}

function applyComputedWeights(assessment = {}, scenarios = [], articles = [], sources = []) {
  const scenarioByName = new Map(scenarios.map((scenario) => [scenario.name, scenario]));
  return {
    ...assessment,
    scenario_scores: Array.isArray(assessment.scenario_scores)
      ? assessment.scenario_scores.map((score) => {
          const scenario = scenarioByName.get(score.scenario);
          if (!scenario) return { ...score, likelihood_percent: clampPercent(score.likelihood_percent), likelihood_band: likelihoodBand(score.likelihood_percent), rationale: scrubImplementationDetails(score.rationale) };
          const calibration = computeScoreCalibrationForScenario(articles, scenario, sources);
          const modelLikelihood = clampPercent(score.likelihood_percent);
          const cappedLikelihood = Math.min(modelLikelihood, calibration.calibratedLikelihood + MAX_MODEL_SCORE_ABOVE_CALIBRATION);
          const finalLikelihood = calibration.matchedSignals.length ? cappedLikelihood : 0;
          return {
            ...score,
            model_likelihood_percent: modelLikelihood,
            likelihood_percent: finalLikelihood,
            likelihood_band: likelihoodBand(finalLikelihood),
            rationale: scrubImplementationDetails(score.rationale),
            matched_signals: calibration.matchedSignals.length ? calibration.matchedSignals : score.matched_signals || [],
            source_weights: calibration.sourceWeights,
            score_calibration: {
              weighted_signal_coverage_percent: calibration.weightedSignalCoverage,
              matched_signal_weight: calibration.matchedWeight,
              total_signal_weight: calibration.maxWeight,
              source_support_percent: calibration.sourceSupport,
              source_diversity_percent: calibration.sourceDiversity,
              calibrated_likelihood_percent: calibration.calibratedLikelihood
            }
          };
        })
      : []
  };
}

async function callModel({ scenarios, articles, sources }) {
  if (!openai || articles.length === 0) {
    return applyComputedWeights({ scenario_scores: heuristicAssessment(scenarios, articles, sources), confidence: articles.length ? "medium" : "low" }, scenarios, articles, sources);
  }
  const precomputedSourceWeights = Object.fromEntries(scenarios.map((scenario) => [scenario.name, computeSourceWeightsForScenario(articles, scenario, sources)]));
  const precomputedScoreCalibrations = Object.fromEntries(scenarios.map((scenario) => [scenario.name, computeScoreCalibrationForScenario(articles, scenario, sources)]));
  const prompt = JSON.stringify({
    instruction: "Estimate each user-defined scenario independently from 0-100 using only the selected source articles. Do not normalize the scores and do not make them sum to 100. Signals have impact weights of 3, 6, or 9. Apply signal weights before source reliability. Use the supplied precomputed source weights and score calibration as fixed constraints; do not invent or recalculate them. Your likelihood must not exceed the calibrated likelihood unless the supplied articles clearly justify stronger evidence. Generic signal matches only count when the article also matches the scenario context, unless the matched signal is high impact. Use these percentage boundaries exactly: 0-14 remote chance, 15-24 highly unlikely, 25-34 unlikely, 35-54 realistic possibility, 55-74 likely/probably, 75-89 highly likely, 90-100 almost certain. Ignore irrelevant articles that do not directly support the scenario signals and context. Never mention implementation details, search tools, providers, fallback behavior, prompts, APIs, models, or internal processing. If evidence is weak or absent, say 'Not enough evidence found to support this scenario.' Do not invent evidence.",
    likelihood_boundaries: LIKELIHOOD_BANDS,
    scenarios: scenarios.map((scenario) => ({
      name: scenario.name,
      description: scenario.description,
      signals: getWeightedSignals(scenario).map((signal) => ({ text: signal.text, weight: signal.weight })),
      total_signal_weight: totalSignalWeight(scenario),
      precomputed_source_weights: precomputedSourceWeights[scenario.name] || [],
      precomputed_score_calibration: precomputedScoreCalibrations[scenario.name] || null
    })),
    selected_sources: sources.map(({ id, name, url, reliability, type, domain }) => ({ id, name, url, type, domain, reliability_percent: reliability })),
    articles: articles.map((article) => ({
      source_id: article.source_id,
      source: article.source,
      reliability_percent: article.reliability,
      title: article.title,
      snippet: article.snippet,
      url: article.url,
      published_at: article.published_at,
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
                required: ["name", "relevance_percent", "reliability_percent", "weighting_percent", "selected"]
              }
            }
          },
          required: ["scenario", "likelihood_percent", "likelihood_band", "rationale", "matched_signals", "source_weights"]
        }
      }
    },
    required: ["confidence", "scenario_scores"]
  };
  const response = await Promise.race([
    openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: [
        { role: "developer", content: [{ type: "input_text", text: "Return compact JSON only. Ground every independent likelihood in the supplied article snippets and weighted user-defined signals. Use precomputed source weights and score calibration as fixed constraints. Never normalize scenario scores against each other. Never mention implementation details such as AI, models, prompts, APIs, or source-search technology in user-facing text." }] },
        { role: "user", content: [{ type: "input_text", text: prompt }] }
      ],
      temperature: 0.2,
      max_output_tokens: 2200,
      text: { format: { type: "json_schema", name: "custom_scenario_assessment", schema, strict: true } }
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("OpenAI request timed out")), OPENAI_TIMEOUT_MS))
  ]);
  const output = response.output_text || response.output?.[0]?.content?.[0]?.text || "{}";
  return applyComputedWeights(JSON.parse(output), scenarios, articles, sources);
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST with scenarios and sources." });
  try {
    const { scenarios, sources } = sanitisePayload(req.body || {});
    if (!scenarios.length) return sendJson(res, 400, { error: "Enter at least one scenario with at least one signal." });
    if (!sources.length) return sendJson(res, 400, { error: "Select at least one source." });
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
      else failed_sources.push({ name: tavilySources[index].name, url: tavilySources[index].url, error: result.reason?.message || "Source search failed" });
    });
    const modelArticles = selectArticlesForModel(articles, scenarios, tavilySources);
    const tavilyArticles = articles.filter((article) => article.searchProvider === "tavily");
    const assessment = await callModel({ scenarios, articles: modelArticles, sources });
    return sendJson(res, 200, {
      assessed_at: new Date().toISOString(),
      scenario_scores: assessment.scenario_scores || [],
      confidence: assessment.confidence || "low",
      likelihood_boundaries: LIKELIHOOD_BANDS,
      sources_used: sources.map(({ id, name, url, reliability, type, domain }) => ({ id, name, url, type, domain, reliability_percent: reliability, selected: true })),
      failed_sources,
      evidence_articles: modelArticles.map(({ source, title, url, published_at, scenario_matches, searchProvider, tavilyQuery }) => ({ source, title, url, published_at, scenario_matches, searchProvider, tavilyQuery })),
      source_diagnostics: {
        topic_first_query_enabled: true,
        score_calibration_enabled: true,
        signal_weights_enabled: true,
        context_relevance_gate_enabled: true,
        source_domain_gate_enabled: true,
        code_computed_source_weights_enabled: true,
        max_model_score_above_calibration: MAX_MODEL_SCORE_ABOVE_CALIBRATION,
        min_contextless_signal_weight: MIN_CONTEXTLESS_SIGNAL_WEIGHT,
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
