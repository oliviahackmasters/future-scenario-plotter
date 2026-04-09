import Parser from "rss-parser";

const parser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent": "future-scenario-plotter/0.1"
  }
});

function normalizeUrl(url, base = "") {
  const value = String(url || "").trim();
  if (!value) return "";
  try {
    return new URL(value, base || undefined).toString();
  } catch {
    return "";
  }
}

function stripTrailingSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "future-scenario-plotter/0.1",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch page (${response.status})`);
  }

  return response.text();
}

function extractFeedLinksFromHtml(html, pageUrl) {
  const matches = [];
  const linkTagRegex = /<link\b[^>]*>/gi;
  const hrefRegex = /\bhref\s*=\s*["']([^"']+)["']/i;
  const relRegex = /\brel\s*=\s*["']([^"']+)["']/i;
  const typeRegex = /\btype\s*=\s*["']([^"']+)["']/i;
  const titleRegex = /\btitle\s*=\s*["']([^"']+)["']/i;

  const tags = html.match(linkTagRegex) || [];

  for (const tag of tags) {
    const relMatch = tag.match(relRegex);
    const typeMatch = tag.match(typeRegex);
    const hrefMatch = tag.match(hrefRegex);
    const titleMatch = tag.match(titleRegex);

    const rel = (relMatch?.[1] || "").toLowerCase();
    const type = (typeMatch?.[1] || "").toLowerCase();
    const href = hrefMatch?.[1] || "";

    if (!rel.includes("alternate")) continue;
    if (!href) continue;

    const isFeedType =
      type.includes("rss") ||
      type.includes("atom") ||
      type.includes("xml");

    if (!isFeedType) continue;

    matches.push({
      url: normalizeUrl(href, pageUrl),
      title: titleMatch?.[1] || ""
    });
  }

  return matches.filter((item) => item.url);
}

function buildCandidatePaths(pageUrl) {
  const url = new URL(pageUrl);
  const origin = `${url.protocol}//${url.host}`;
  const pathname = stripTrailingSlash(url.pathname);

  const candidates = [
    `${origin}/feed`,
    `${origin}/rss`,
    `${origin}/rss.xml`,
    `${origin}/feed.xml`,
    `${origin}/atom.xml`
  ];

  if (pathname) {
    candidates.push(`${origin}${pathname}/feed`);
    candidates.push(`${origin}${pathname}/rss`);
    candidates.push(`${origin}${pathname}.xml`);
  }

  return Array.from(new Set(candidates));
}

async function validateFeed(url) {
  try {
    const feed = await parser.parseURL(url);
    const items = Array.isArray(feed.items) ? feed.items : [];

    return {
      ok: true,
      feed: {
        url,
        title: feed.title || "",
        itemCount: items.length
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message
    };
  }
}

export async function discoverFeedFromWebsite(websiteUrl) {
  const normalizedWebsite = normalizeUrl(websiteUrl);
  if (!normalizedWebsite) {
    return {
      ok: false,
      message: "Website URL is invalid."
    };
  }

  let html = "";
  try {
    html = await fetchText(normalizedWebsite);
  } catch (error) {
    return {
      ok: false,
      message: `Could not fetch website: ${error.message}`
    };
  }

  const autoDiscovered = extractFeedLinksFromHtml(html, normalizedWebsite);
  const candidateUrls = [
    ...autoDiscovered.map((item) => item.url),
    ...buildCandidatePaths(normalizedWebsite)
  ];

  const uniqueCandidates = Array.from(new Set(candidateUrls.filter(Boolean)));

  for (const candidateUrl of uniqueCandidates) {
    const validated = await validateFeed(candidateUrl);
    if (validated.ok) {
      return {
        ok: true,
        source: {
          homepage: normalizedWebsite,
          feedUrl: candidateUrl,
          feedTitle: validated.feed.title,
          itemCount: validated.feed.itemCount,
          method: autoDiscovered.some((item) => item.url === candidateUrl)
            ? "autodiscovery"
            : "common_path"
        }
      };
    }
  }

  return {
    ok: false,
    message: "Could not detect a valid RSS/Atom feed from that website."
  };
}

export async function validateKnownFeed(feedUrl) {
  const normalizedFeed = normalizeUrl(feedUrl);
  if (!normalizedFeed) {
    return {
      ok: false,
      message: "Feed URL is invalid."
    };
  }

  const validated = await validateFeed(normalizedFeed);
  if (!validated.ok) {
    return {
      ok: false,
      message: `Feed validation failed: ${validated.error}`
    };
  }

  return {
    ok: true,
    source: {
      feedUrl: normalizedFeed,
      feedTitle: validated.feed.title,
      itemCount: validated.feed.itemCount
    }
  };
}