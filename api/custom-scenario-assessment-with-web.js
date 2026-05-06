import customScenarioHandler from "./custom-scenario-assessment.js";

function getBaseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "";
  if (configured) return configured.startsWith("http") ? configured.replace(/\/$/, "") : `https://${configured.replace(/\/$/, "")}`;

  const host = req.headers?.host || "";
  const proto = req.headers?.["x-forwarded-proto"] || "https";
  return host ? `${proto}://${host}` : "";
}

function compactScenarioQuery(scenarios = []) {
  return Array.from(new Set(
    scenarios.flatMap((scenario) => [
      scenario?.name,
      scenario?.description,
      ...(Array.isArray(scenario?.signals) ? scenario.signals : [])
    ])
      .map((value) => String(value || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
  )).slice(0, 12).join(" OR ");
}

function hostnameFromUrl(raw = "") {
  try {
    const parsed = new URL(String(raw).startsWith("http") ? raw : `https://${raw}`);
    return parsed.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function tavilyBridgeSource({ baseUrl, domain, query, reliability = 70 }) {
  const topic = "custom";
  const params = new URLSearchParams({ topic, domain, q: query });
  return {
    id: `tavily-${domain}-${Math.abs(query.length)}`,
    name: `${domain} Web Search`,
    url: `${baseUrl}/api/tavily-rss?${params.toString()}`,
    reliability,
    enabled: true,
    type: "rss"
  };
}

function addTavilySourcesToBody(req) {
  if (!process.env.TAVILY_API_KEY || !req.body || typeof req.body !== "object") return;

  const baseUrl = getBaseUrl(req);
  if (!baseUrl) return;

  const scenarios = Array.isArray(req.body.scenarios) ? req.body.scenarios : [];
  const query = compactScenarioQuery(scenarios) || "future scenario signals";
  const suppliedSources = Array.isArray(req.body.sources) ? req.body.sources : [];

  const userDomains = suppliedSources
    .map((source) => hostnameFromUrl(source?.url || source?.homepage || ""))
    .filter(Boolean)
    .filter((domain) => !domain.includes("news.google.com"));

  const domains = Array.from(new Set([
    "reuters.com",
    "reddit.com",
    "substack.com",
    ...userDomains
  ])).slice(0, 8);

  const tavilySources = domains.map((domain) => tavilyBridgeSource({ baseUrl, domain, query }));

  req.body.sources = [
    ...suppliedSources,
    ...tavilySources
  ];
}

export default async function handler(req, res) {
  addTavilySourcesToBody(req);
  return customScenarioHandler(req, res);
}
