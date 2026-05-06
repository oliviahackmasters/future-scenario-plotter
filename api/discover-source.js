import { findCatalogSourceByName } from "../lib/source-catalog.js";
import {
  discoverFeedFromWebsite,
  validateKnownFeed
} from "../lib/feed-discovery.js";
import { hostnameFromUrl } from "../lib/tavily-search.js";

function getAllowedOrigin(req) {
  const requestOrigin = req.headers.origin || "";
  const configured = String(process.env.ALLOWED_ORIGIN || "").trim();

  if (!configured) return "*";
  if (configured === "*") return "*";
  if (requestOrigin && requestOrigin === configured) return configured;

  return configured;
}

function setCors(req, res) {
  const origin = getAllowedOrigin(req);
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(req, res, status, body) {
  setCors(req, res);
  res.status(status).setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(body));
}

function parseBody(req) {
  if (typeof req.body === "object" && req.body !== null) return req.body;
  try {
    return JSON.parse(req.body || "{}");
  } catch {
    return {};
  }
}

function getPublicBaseUrl(req) {
  const configured = process.env.PUBLIC_BASE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "";
  if (configured) return configured.startsWith("http") ? configured.replace(/\/$/, "") : `https://${configured.replace(/\/$/, "")}`;

  const host = req.headers?.host || "";
  const proto = req.headers?.["x-forwarded-proto"] || "https";
  return host ? `${proto}://${host}` : "";
}

function normaliseWebsite(value = "") {
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

function looksLikeFeedUrl(value = "") {
  const url = String(value || "").toLowerCase();
  return url.includes("rss") || url.includes("feed") || url.includes(".xml") || url.includes("feeds.");
}

function buildTavilySource({ req, topic, name, website, confidence = 0.9 }) {
  const homepage = normaliseWebsite(website);
  const domain = hostnameFromUrl(homepage || website);
  const baseUrl = getPublicBaseUrl(req);

  if (!domain || !baseUrl) return null;

  const encodedTopic = encodeURIComponent(String(topic || "iran").trim().toLowerCase());
  const encodedDomain = encodeURIComponent(domain);

  return {
    name: name || domain,
    url: `${baseUrl}/api/tavily-rss?topic=${encodedTopic}&domain=${encodedDomain}`,
    type: "rss",
    enabled: true,
    homepage: homepage || `https://${domain}`,
    confidence,
    discovered_by: "tavily_custom_domain",
    validated_at: new Date().toISOString()
  };
}

function tavilyResponse(req, topic, name, website, method = "tavily_domain") {
  const source = buildTavilySource({ req, topic, name, website });
  if (!source) {
    return null;
  }

  return {
    ok: true,
    method,
    topic,
    source,
    validation: {
      feed_title: `${source.name} Tavily web search`,
      item_count: null,
      note: "Website/domain source will be searched through Tavily instead of RSS validation."
    }
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return json(req, res, 200, { ok: true });
  }

  if (req.method !== "POST") {
    return json(req, res, 405, { error: "method_not_allowed" });
  }

  try {
    const body = parseBody(req);
    const topic = String(req.query.topic || body.topic || "iran").trim();
    const name = String(body.name || "").trim();
    const website = String(body.website || "").trim();
    const url = String(body.url || "").trim();

    // Custom hardcoded-plotter source input: name + website/domain should become a Tavily source.
    // Preserve RSS behavior only when the URL clearly looks like a feed.
    if (name && url && !looksLikeFeedUrl(url)) {
      const response = tavilyResponse(req, topic, name, url, "custom_tavily_domain");
      if (response) return json(req, res, 200, response);
    }

    if (name && website && !looksLikeFeedUrl(website)) {
      const response = tavilyResponse(req, topic, name, website, "custom_tavily_domain");
      if (response) return json(req, res, 200, response);
    }

    // Handle custom RSS source: name + RSS URL provided directly.
    if (name && url) {
      const validated = await validateKnownFeed(url);
      if (!validated.ok) {
        return json(req, res, 422, {
          ok: false,
          error: "custom_feed_invalid",
          message: `The provided URL is not a valid RSS feed: ${validated.error}`
        });
      }

      return json(req, res, 200, {
        ok: true,
        method: "custom",
        topic,
        source: {
          name,
          url: validated.source.feedUrl,
          type: "rss",
          enabled: true,
          homepage: "",
          confidence: 0.9,
          discovered_by: "custom",
          validated_at: new Date().toISOString()
        },
        validation: {
          feed_title: validated.source.feedTitle,
          item_count: validated.source.itemCount
        }
      });
    }

    // Handle direct RSS URL (website field used as RSS URL)
    if (website && looksLikeFeedUrl(website)) {
      const validated = await validateKnownFeed(website);
      if (!validated.ok) {
        return json(req, res, 422, {
          ok: false,
          error: "direct_feed_invalid",
          message: `The provided RSS URL is not a valid feed: ${validated.error}`
        });
      }

      return json(req, res, 200, {
        ok: true,
        method: "direct_rss",
        topic,
        source: {
          name: name || validated.source.feedTitle || website,
          url: validated.source.feedUrl,
          type: "rss",
          enabled: true,
          homepage: "",
          confidence: 0.9,
          discovered_by: "direct_rss",
          validated_at: new Date().toISOString()
        },
        validation: {
          feed_title: validated.source.feedTitle,
          item_count: validated.source.itemCount
        }
      });
    }

    // Website/domain input should default to Tavily, not RSS validation.
    if (website && (website.startsWith("http://") || website.startsWith("https://") || hostnameFromUrl(website))) {
      const response = tavilyResponse(req, topic, name || hostnameFromUrl(website), website, "website_tavily_domain");
      if (response) return json(req, res, 200, response);
    }

    const matched = name ? findCatalogSourceByName(name) : null;

    if (matched) {
      const validated = await validateKnownFeed(matched.feedUrl);

      if (validated.ok) {
        return json(req, res, 200, {
          ok: true,
          method: "catalog",
          topic,
          source: {
            name: matched.name,
            url: validated.source.feedUrl,
            type: "rss",
            enabled: true,
            homepage: matched.homepage || "",
            confidence: 1,
            discovered_by: "catalog",
            validated_at: new Date().toISOString()
          },
          validation: {
            feed_title: validated.source.feedTitle,
            item_count: validated.source.itemCount
          }
        });
      }

      if (website && looksLikeFeedUrl(website)) {
        const discovered = await discoverFeedFromWebsite(website);

        if (discovered.ok) {
          return json(req, res, 200, {
            ok: true,
            method: discovered.source.method,
            topic,
            source: {
              name: matched.name,
              url: discovered.source.feedUrl,
              type: "rss",
              enabled: true,
              homepage: discovered.source.homepage,
              confidence: 0.85,
              discovered_by: discovered.source.method,
              validated_at: new Date().toISOString()
            },
            validation: {
              feed_title: discovered.source.feedTitle,
              item_count: discovered.source.itemCount
            }
          });
        }
      }

      return json(req, res, 422, {
        ok: false,
        error: "catalog_feed_invalid",
        message: "Known source matched, but the stored feed is no longer valid. Try adding a website/domain URL to search it through Tavily."
      });
    }

    // Last resort: feed discovery only for URLs that look like RSS/feed URLs.
    if (website && looksLikeFeedUrl(website)) {
      const discovered = await discoverFeedFromWebsite(website);

      if (!discovered.ok) {
        return json(req, res, 422, {
          ok: false,
          error: "feed_discovery_failed",
          message: discovered.message
        });
      }

      return json(req, res, 200, {
        ok: true,
        method: discovered.source.method,
        topic,
        source: {
          name: name || discovered.source.feedTitle || website,
          url: discovered.source.feedUrl,
          type: "rss",
          enabled: true,
          homepage: discovered.source.homepage,
          confidence: 0.85,
          discovered_by: discovered.source.method,
          validated_at: new Date().toISOString()
        },
        validation: {
          feed_title: discovered.source.feedTitle,
          item_count: discovered.source.itemCount
        }
      });
    }

    return json(req, res, 422, {
      ok: false,
      error: "not_found",
      message: "Could not find that source by name. Try providing both a source name and a website/domain URL to search through Tavily."
    });
  } catch (error) {
    return json(req, res, 500, {
      ok: false,
      error: "discover_source_failed",
      message: error.message
    });
  }
}
