const TAVILY_API_URL = "https://api.tavily.com/search";
const DEFAULT_TAVILY_TIMEOUT_MS = 9000;

export const DEFAULT_TAVILY_DOMAINS = [
  "reuters.com",
  "reddit.com",
  "substack.com",
  "bellingcat.com",
  "x.com",
  "twitter.com",
  "threads.net"
];

function cleanText(value, max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function hostnameFromUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    return parsed.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function isDefaultTavilyDomain(url = "") {
  return DEFAULT_TAVILY_DOMAINS.some((domain) => url.includes(domain));
}

export function getTavilyDomainsFromSources(sources = []) {
  return Array.from(new Set(
    sources
      .filter((source) => source && source.enabled !== false)
      .filter((source) => {
        const type = String(source.type || "").trim().toLowerCase();
        const url = String(source.url || source.homepage || "").toLowerCase();
        return ["web", "site", "domain", "tavily"].includes(type) || isDefaultTavilyDomain(url);
      })
      .map((source) => hostnameFromUrl(source.url || source.homepage))
      .filter(Boolean)
  ));
}

export function buildScenarioSearchQuery({ topicConfig, topic, scenarios = [], extraTerms = [] } = {}) {
  const terms = [
    topicConfig?.newsApiQuery,
    topicConfig?.label,
    topic,
    ...extraTerms,
    ...scenarios.flatMap((scenario) => [
      scenario?.name,
      scenario?.description,
      ...(Array.isArray(scenario?.signals) ? scenario.signals : []),
      ...(Array.isArray(scenario?.scenarioSignals) ? scenario.scenarioSignals : [])
    ])
  ]
    .map((value) => cleanText(value, 140))
    .filter(Boolean);

  return Array.from(new Set(terms)).slice(0, 12).join(" OR ");
}

function withTimeout(ms = DEFAULT_TAVILY_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timeoutId) };
}

export async function fetchTavilyArticles({
  query,
  domains = [],
  maxResults = 8,
  timeoutMs = DEFAULT_TAVILY_TIMEOUT_MS
} = {}) {
  if (!process.env.TAVILY_API_KEY || !String(query || "").trim()) return [];

  const includeDomains = Array.from(new Set([...DEFAULT_TAVILY_DOMAINS, ...domains].filter(Boolean)));
  const { signal, clear } = withTimeout(timeoutMs);

  try {
    const response = await fetch(TAVILY_API_URL, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.TAVILY_API_KEY}`
      },
      body: JSON.stringify({
        query,
        search_depth: "advanced",
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false,
        include_domains: includeDomains.length ? includeDomains : undefined
      })
    });

    if (!response.ok) {
      throw new Error(`Tavily fetch failed ${response.status}`);
    }

    const data = await response.json();
    return (Array.isArray(data.results) ? data.results : []).map((item, index) => {
      const url = String(item.url || "").trim();
      const hostname = hostnameFromUrl(url);
      const sourceName = cleanText(item.source || hostname || "Tavily", 120);

      return {
        source_id: `tavily-${hostname || index}`,
        source: sourceName,
        source_url: url,
        reliability: 70,
        title: cleanText(item.title, 220),
        snippet: cleanText(item.content || item.snippet || "", 360),
        contentSnippet: cleanText(item.content || item.snippet || "", 360),
        content: "",
        url,
        published_at: item.published_date || null,
        isoDate: item.published_date || null,
        searchProvider: "tavily"
      };
    }).filter((item) => item.title || item.snippet || item.url);
  } finally {
    clear();
  }
}
