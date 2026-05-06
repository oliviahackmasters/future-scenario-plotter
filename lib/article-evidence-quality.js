const DEFAULT_RECENCY_WINDOW_DAYS = 45;
const MAX_USABLE_AGE_DAYS = 180;

function cleanText(value, max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function parseDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function articleAgeDays(article, now = new Date()) {
  const published = parseDate(article?.published_at || article?.isoDate || article?.pubDate || article?.published_date);
  if (!published) return null;
  return Math.max(0, Math.floor((now.getTime() - published.getTime()) / 86400000));
}

export function recencyMultiplier(article, options = {}) {
  const age = articleAgeDays(article, options.now || new Date());
  const recencyWindowDays = Number(options.recencyWindowDays || DEFAULT_RECENCY_WINDOW_DAYS);
  const maxUsableAgeDays = Number(options.maxUsableAgeDays || MAX_USABLE_AGE_DAYS);

  if (age === null) return 0.35;
  if (age <= recencyWindowDays) return 1;
  if (age <= recencyWindowDays * 2) return 0.65;
  if (age <= maxUsableAgeDays) return 0.25;
  return 0;
}

export function isFreshEnough(article, options = {}) {
  return recencyMultiplier(article, options) > 0;
}

export function evidencePagePenalty(article) {
  const url = String(article?.url || "").toLowerCase();
  const title = String(article?.title || "").toLowerCase();
  const snippet = String(article?.snippet || article?.contentSnippet || "").toLowerCase();

  if (/\/sitemap\//.test(url) || /\/tag\//.test(url) || /\/tags\//.test(url) || /\/category\//.test(url) || /\/search\?/.test(url)) return 0;
  if (title === "home" || /home \|/.test(title) || title.includes("schedule") || title.includes("episode guide") || title.includes("sitemap")) return 0;
  if (title.includes("what is") || title.includes("explainer") || title.includes("guide to") || title.includes("how to")) return 0.45;
  if (snippet.includes("beginner") || snippet.includes("overview") || snippet.includes("background")) return 0.7;
  return 1;
}

export function directnessMultiplier(match = {}) {
  const score = Number(match.score || 0);
  const weightedScore = Number(match.weightedScore || score || 0);
  if (!score || !weightedScore) return 0;
  if (Array.isArray(match.matchedSignals) && match.matchedSignals.length >= 2) return 1;
  return 0.75;
}

export function relevanceQualityPercent({ article, match, maxWeight, now = new Date() }) {
  const base = maxWeight ? Math.min(100, Math.round((Number(match?.score || 0) / maxWeight) * 100)) : 0;
  const multiplier = recencyMultiplier(article, { now }) * evidencePagePenalty(article) * directnessMultiplier(match);
  return Math.max(0, Math.min(100, Math.round(base * multiplier)));
}

export function evidenceQualityForArticle(article, now = new Date()) {
  const age = articleAgeDays(article, now);
  const recency = recencyMultiplier(article, { now });
  const pagePenalty = evidencePagePenalty(article);
  if (recency === 0 || pagePenalty === 0) return "invalid";
  if (age === null || recency < 0.65 || pagePenalty < 0.7) return "weak";
  if (pagePenalty < 1) return "background";
  return "current";
}

export function qualityAdjustedMatch(article, match, maxWeight, now = new Date()) {
  const relevance = relevanceQualityPercent({ article, match, maxWeight, now });
  return {
    ...match,
    raw_score: Number(match?.score || 0),
    score: Math.round((relevance / 100) * maxWeight),
    weightedScore: Math.round((relevance / 100) * maxWeight),
    relevance_quality_percent: relevance,
    evidence_quality: evidenceQualityForArticle(article, now),
    article_age_days: articleAgeDays(article, now)
  };
}
