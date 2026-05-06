import { buildScenarioSearchQuery, fetchTavilyArticles } from "../lib/tavily-search.js";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function escapeXml(value = "") {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normaliseDomain(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  try {
    const topic = String(req.query.topic || "global").trim();
    const domain = normaliseDomain(req.query.domain || "");
    const q = String(req.query.q || "").trim();
    const query = q || buildScenarioSearchQuery({ topic, extraTerms: [topic] }) || topic;
    const limit = Number(req.query.limit || 4);

    const articles = await fetchTavilyArticles({
      query,
      domains: domain ? [domain] : [],
      maxResults: limit,
      useDefaultDomains: !domain,
      searchDepth: "basic"
    });

    res.setHeader("X-FSP-Tavily-Domain", domain || "default");
    res.setHeader("X-FSP-Tavily-Query", query.slice(0, 240));
    res.setHeader("X-FSP-Tavily-Result-Count", String(articles.length));

    if (req.query.format === "json" || req.query.debug === "1") {
      res.status(200).setHeader("Content-Type", "application/json; charset=utf-8");
      return res.send(JSON.stringify({
        provider: "tavily",
        topic,
        domain: domain || null,
        query,
        requested_limit: limit,
        result_count: articles.length,
        articles: articles.map(({ source, title, url, published_at, snippet, contentSnippet }) => ({
          source,
          title,
          url,
          published_at,
          snippet: snippet || contentSnippet || ""
        }))
      }));
    }

    const items = articles.map((article) => `
      <item>
        <title>${escapeXml(article.title)}</title>
        <link>${escapeXml(article.url)}</link>
        <guid>${escapeXml(article.url)}</guid>
        <pubDate>${escapeXml(article.published_at || new Date().toUTCString())}</pubDate>
        <description>${escapeXml(article.snippet || article.contentSnippet || "")}</description>
        <source>${escapeXml(article.source || domain || "Tavily")}</source>
      </item>`).join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeXml(`Tavily ${domain || "web"} search: ${topic}`)}</title>
    <link>https://tavily.com</link>
    <description>${escapeXml(`Tavily-backed web search results for ${topic}. Result count: ${articles.length}. Query: ${query}`)}</description>
    ${items}
  </channel>
</rss>`;

    res.status(200).setHeader("Content-Type", "application/rss+xml; charset=utf-8");
    return res.send(xml);
  } catch (error) {
    console.error("Tavily RSS failed:", error);
    res.status(500).setHeader("Content-Type", "application/rss+xml; charset=utf-8");
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Tavily RSS error</title><description>${escapeXml(error.message || "Tavily RSS failed")}</description></channel></rss>`);
  }
}
