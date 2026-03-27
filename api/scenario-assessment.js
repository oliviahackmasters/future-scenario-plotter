import Parser from "rss-parser";
import OpenAI from "openai";

const parser = new Parser();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TOPICS = {
  iran: {
    label: "Iran",
    scenarios: [
      {
        name: "Chaos + Collapse",
        description: "Multi-state regional war and a dysfunctional government in Iran."
      },
      {
        name: "Shattered Diplomacy",
        description: "Post-Iran fragmentation and multiple weak political actors."
      },
      {
        name: "Burning Strait",
        description: "Full regional war with no major ideological change in Iran."
      },
      {
        name: "Cold Containment",
        description: "Managed escalation with minimal or no ground troops."
      }
    ],
    trackedSignals: [
      "oil prices",
      "troop deployment",
      "government stability",
      "diplomacy / ceasefire",
      "maritime disruption",
      "protests / elite fragmentation",
      "prediction market odds"
    ],
    sources: [
      { name: "BBC World", url: "http://feeds.bbci.co.uk/news/world/rss.xml" },
      { name: "BBC Middle East", url: "http://feeds.bbci.co.uk/news/world/middle_east/rss.xml" },
      { name: "Reuters World", url: "https://feeds.reuters.com/Reuters/worldNews" }
    ],
    keywordFilter: [
      "iran",
      "tehran",
      "strait of hormuz",
      "hormuz",
      "israel",
      "us military",
      "troops",
      "oil",
      "ceasefire",
      "sanctions"
    ],
    polymarketSearchTerms: [
      "iran",
      "hormuz",
      "middle east war",
      "israel iran"
    ]
  }
};

function getTopicConfig(topic) {
  return TOPICS[String(topic || "iran").toLowerCase()] || TOPICS.iran;
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.send(JSON.stringify(body));
}

function scoreAndSort(items) {
  return items
    .map((item) => {
      const haystack = `${item.title} ${item.contentSnippet} ${item.content}`.toLowerCase();
      let matches = 0;
      for (const keyword of item.keywords || []) {
        if (haystack.includes(keyword)) matches += 1;
      }
      return { ...item, _matches: matches };
    })
    .filter((item) => item._matches > 0)
    .sort((a, b) => b._matches - a._matches || (b.isoDate || "").localeCompare(a.isoDate || ""));
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for ${url}`);
  }
  return res.json();
}

async function fetchRssItems(source, keywordFilter) {
  try {
    const feed = await parser.parseURL(source.url);
    const items = Array.isArray(feed.items) ? feed.items : [];
    return items.slice(0, 12).map((item) => ({
      source: source.name,
      url: item.link || source.url,
      title: normalizeWhitespace(item.title),
      contentSnippet: normalizeWhitespace(item.contentSnippet || item.summary || ""),
      content: normalizeWhitespace(item.content || item["content:encoded"] || item.summary || ""),
      isoDate: item.isoDate || item.pubDate || null,
      keywords: keywordFilter
    }));
  } catch (error) {
    console.error(`Failed to fetch ${source.name}:`, error.message);
    return [];
  }
}

async function collectTopicCoverage(topicConfig) {
  const itemGroups = await Promise.all(
    topicConfig.sources.map((source) => fetchRssItems(source, topicConfig.keywordFilter))
  );

  const filtered = scoreAndSort(itemGroups.flat()).slice(0, 15);

  return filtered.map((item) => ({
    source: item.source,
    url: item.url,
    title: item.title,
    published_at: item.isoDate,
    snippet: item.contentSnippet || item.content
  }));
}

async function fetchOilSignal() {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) {
    return {
      source: "Alpha Vantage",
      status: "unavailable",
      latest: null,
      signal: {
        name: "oil prices",
        reading: "Oil API key not configured.",
        direction: "neutral",
        confidence: "Low"
      }
    };
  }

  try {
    const url = `https://www.alphavantage.co/query?function=BRENT&interval=monthly&apikey=${encodeURIComponent(apiKey)}`;
    const data = await fetchJson(url);
    const series = Array.isArray(data.data) ? data.data : [];
    const latest = series[0] ? Number(series[0].value) : null;
    const previous = series[1] ? Number(series[1].value) : null;

    let direction = "neutral";
    let reading = "Brent data available but move is limited.";
    let confidence = "Medium";

    if (latest != null && previous != null) {
      const deltaPct = previous === 0 ? 0 : ((latest - previous) / previous) * 100;

      if (latest >= 85 || deltaPct >= 8) {
        direction = "escalatory";
        reading = `Brent is elevated at ${latest.toFixed(2)} USD/bbl, up from ${previous.toFixed(2)}.`;
      } else if (latest <= 70 && deltaPct <= -5) {
        direction = "de-escalatory";
        reading = `Brent has eased to ${latest.toFixed(2)} USD/bbl from ${previous.toFixed(2)}.`;
      } else {
        reading = `Brent is ${latest.toFixed(2)} USD/bbl versus ${previous.toFixed(2)} previously.`;
      }
    } else {
      confidence = "Low";
      reading = "Oil feed returned insufficient data.";
    }

    return {
      source: "Alpha Vantage",
      status: "ok",
      latest,
      previous,
      signal: {
        name: "oil prices",
        reading,
        direction,
        confidence
      }
    };
  } catch (error) {
    console.error("Oil signal failed:", error.message);
    return {
      source: "Alpha Vantage",
      status: "error",
      latest: null,
      signal: {
        name: "oil prices",
        reading: `Oil feed unavailable: ${error.message}`,
        direction: "neutral",
        confidence: "Low"
      }
    };
  }
}

function scorePolymarketScenario(question, yesPrice) {
  const q = String(question || "").toLowerCase();
  const p = Number(yesPrice || 0);

  if (
    q.includes("hormuz") ||
    q.includes("regional war") ||
    q.includes("iran") && q.includes("israel") && q.includes("war")
  ) {
    return { scenario: "Burning Strait", weight: p };
  }

  if (
    q.includes("regime collapse") ||
    q.includes("government collapse") ||
    q.includes("iran collapse") ||
    q.includes("supreme leader removed")
  ) {
    return { scenario: "Chaos + Collapse", weight: p };
  }

  if (
    q.includes("deal") ||
    q.includes("ceasefire") ||
    q.includes("talks") ||
    q.includes("negotiation")
  ) {
    return { scenario: "Cold Containment", weight: 1 - p };
  }

  if (
    q.includes("fragment") ||
    q.includes("fragmentation") ||
    q.includes("multiple governments") ||
    q.includes("power vacuum")
  ) {
    return { scenario: "Shattered Diplomacy", weight: p };
  }

  return null;
}

async function fetchPolymarketSignal(topicConfig) {
  try {
    const markets = await fetchJson("https://gamma-api.polymarket.com/markets");
    const active = Array.isArray(markets) ? markets : [];

    const filtered = active
      .filter((m) => m.active && !m.closed)
      .filter((m) => {
        const text = `${m.question || ""} ${m.description || ""} ${(m.events || []).map(e => e.title || "").join(" ")}`.toLowerCase();
        return topicConfig.polymarketSearchTerms.some((term) => text.includes(term));
      })
      .slice(0, 40);

    const weights = new Map([
      ["Chaos + Collapse", 0],
      ["Shattered Diplomacy", 0],
      ["Burning Strait", 0],
      ["Cold Containment", 0]
    ]);

    const matchedMarkets = [];

    for (const market of filtered) {
      const outcomePrices = Array.isArray(market.outcomePrices)
        ? market.outcomePrices
        : typeof market.outcomePrices === "string"
          ? JSON.parse(market.outcomePrices || "[]")
          : [];

      const yesPrice = Number(outcomePrices[0] || 0);
      const mapped = scorePolymarketScenario(market.question, yesPrice);

      if (mapped) {
        weights.set(mapped.scenario, weights.get(mapped.scenario) + mapped.weight);
        matchedMarkets.push({
          question: market.question,
          scenario: mapped.scenario,
          yesPrice
        });
      }
    }

    const topScenario = [...weights.entries()].sort((a, b) => b[1] - a[1])[0];
    const reading = matchedMarkets.length
      ? `Polymarket signals lean toward ${topScenario[0]} based on ${matchedMarkets.length} matched live markets.`
      : "No strongly matched Polymarket markets found for this topic.";

    return {
      source: "Polymarket",
      status: "ok",
      weights: Object.fromEntries(weights),
      matchedMarkets,
      signal: {
        name: "prediction market odds",
        reading,
        direction: matchedMarkets.length ? "escalatory" : "neutral",
        confidence: matchedMarkets.length >= 3 ? "Medium" : "Low"
      }
    };
  } catch (error) {
    console.error("Polymarket fetch failed:", error.message);
    return {
      source: "Polymarket",
      status: "error",
      weights: {},
      matchedMarkets: [],
      signal: {
        name: "prediction market odds",
        reading: `Prediction market feed unavailable: ${error.message}`,
        direction: "neutral",
        confidence: "Low"
      }
    };
  }
}

async function fetchSocialSignal(topicConfig) {
  const endpoint = process.env.SOCIAL_SIGNAL_ENDPOINT;
  if (!endpoint) {
    return {
      source: "Social",
      status: "unavailable",
      items: [],
      signal: {
        name: "social early warning",
        reading: "No social signal endpoint configured.",
        direction: "neutral",
        confidence: "Low"
      }
    };
  }

  try {
    const data = await fetchJson(endpoint);
    const items = Array.isArray(data.items) ? data.items : [];
    const filtered = items
      .filter((item) => {
        const text = `${item.text || ""} ${item.title || ""}`.toLowerCase();
        return topicConfig.keywordFilter.some((term) => text.includes(term));
      })
      .slice(0, 12);

    const alertCount = filtered.filter((item) => item.severity === "high").length;
    let direction = "neutral";
    let confidence = "Low";
    let reading = "Social layer shows limited early warning activity.";

    if (alertCount >= 3) {
      direction = "escalatory";
      confidence = "Medium";
      reading = `${alertCount} high-severity social signals matched the topic in the latest batch.`;
    } else if (filtered.length >= 5) {
      confidence = "Medium";
      reading = `${filtered.length} social items matched the topic, but without a strong high-severity cluster.`;
    }

    return {
      source: "Social",
      status: "ok",
      items: filtered,
      signal: {
        name: "social early warning",
        reading,
        direction,
        confidence
      }
    };
  } catch (error) {
    console.error("Social signal failed:", error.message);
    return {
      source: "Social",
      status: "error",
      items: [],
      signal: {
        name: "social early warning",
        reading: `Social layer unavailable: ${error.message}`,
        direction: "neutral",
        confidence: "Low"
      }
    };
  }
}

function buildPrompt(topicConfig, articles, externalSignals) {
  return [
    "You are a geopolitical scenario analyst.",
    "",
    `Topic: ${topicConfig.label}`,
    "",
    "Tracked signals:",
    ...topicConfig.trackedSignals.map((signal) => `- ${signal}`),
    "",
    "Scenarios:",
    ...topicConfig.scenarios.map((scenario, index) => `${index + 1}. ${scenario.name} = ${scenario.description}`),
    "",
    "Use both the source summaries and the structured external signals below.",
    "If a direct market or oil feed conflicts with narrative reporting, note the conflict.",
    "Do not invent facts. Distinguish evidence from inference.",
    "",
    "Articles:",
    JSON.stringify(articles, null, 2),
    "",
    "External signals:",
    JSON.stringify(externalSignals, null, 2),
    "",
    "Return JSON matching the schema."
  ].join("\n");
}

const responseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    scenarios: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          score: { type: "number" },
          description: { type: "string" }
        },
        required: ["name", "score", "description"]
      }
    },
    signals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          reading: { type: "string" },
          direction: {
            type: "string",
            enum: ["escalatory", "neutral", "de-escalatory"]
          },
          confidence: {
            type: "string",
            enum: ["Low", "Medium", "High"]
          }
        },
        required: ["name", "reading", "direction", "confidence"]
      }
    }
  },
  required: ["summary", "scenarios", "signals"]
};

function normalizeScenarioScores(output, scenariosFromConfig, polymarketWeights = {}) {
  const byName = new Map(output.scenarios.map((item) => [item.name, item]));

  const merged = scenariosFromConfig.map((scenario) => {
    const found = byName.get(scenario.name);
    const aiScore = Number(found?.score || 0);
    const marketBoost = Number(polymarketWeights[scenario.name] || 0) * 20;

    return {
      name: scenario.name,
      description: found?.description || scenario.description,
      score: aiScore + marketBoost
    };
  });

  const rawTotal = merged.reduce((sum, item) => sum + item.score, 0);
  if (rawTotal <= 0) {
    const equalScore = Math.floor(100 / merged.length);
    return merged.map((item, index) => ({
      ...item,
      score: index === merged.length - 1 ? 100 - equalScore * (merged.length - 1) : equalScore
    }));
  }

  let running = 0;
  return merged.map((item, index) => {
    if (index === merged.length - 1) {
      return { ...item, score: Math.max(0, 100 - running) };
    }
    const normalized = Math.round((item.score / rawTotal) * 100);
    running += normalized;
    return { ...item, score: normalized };
  });
}

function upsertSignal(signals, newSignal) {
  const idx = signals.findIndex((s) => s.name === newSignal.name);
  if (idx >= 0) signals[idx] = newSignal;
  else signals.push(newSignal);
}

async function generateScenarioAssessment(topicConfig, articles, externalSignals) {
  if (!articles.length && !externalSignals.length) {
    return {
      summary: "Not enough current source material was available to generate a live assessment.",
      scenarios: topicConfig.scenarios.map((scenario, index) => ({
        ...scenario,
        score: index === topicConfig.scenarios.length - 1 ? 25 : 25
      })),
      signals: topicConfig.trackedSignals.map((signal) => ({
        name: signal,
        reading: "No recent evidence available in current fetch.",
        direction: "neutral",
        confidence: "Low"
      }))
    };
  }

  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: [
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: "Produce a concise geopolitical scenario assessment using only the supplied source material and external signal payloads."
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: buildPrompt(topicConfig, articles, externalSignals)
          }
        ]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "scenario_assessment",
        schema: responseSchema,
        strict: true
      }
    }
  });

  const parsed = JSON.parse(response.output_text);

  const polymarket = externalSignals.find((s) => s.source === "Polymarket");
  const normalizedScenarios = normalizeScenarioScores(
    parsed,
    topicConfig.scenarios,
    polymarket?.weights || {}
  );

  const signals = [...parsed.signals];
  for (const ext of externalSignals) {
    if (ext.signal?.name) upsertSignal(signals, ext.signal);
  }

  return {
    summary: parsed.summary,
    scenarios: normalizedScenarios,
    signals
  };
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return json(res, 200, { ok: true });
  }

  if (req.method !== "GET") {
    return json(res, 405, { error: "method_not_allowed" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return json(res, 500, {
      error: "missing_openai_api_key",
      message: "OPENAI_API_KEY is not set."
    });
  }

  try {
    const topicConfig = getTopicConfig(req.query.topic);

    const [articles, oilSignal, polymarketSignal] = await Promise.all([
    collectTopicCoverage(topicConfig),
    fetchOilSignal(),
    fetchPolymarketSignal(topicConfig)
    ]);

    const externalSignals = [oilSignal, polymarketSignal];
    const assessment = await generateScenarioAssessment(topicConfig, articles, externalSignals);

    return json(res, 200, {
      topic: topicConfig.label,
      updated_at: new Date().toISOString(),
      summary: assessment.summary,
      scenarios: assessment.scenarios,
      signals: assessment.signals,
      sources: [
        ...articles.map((article) => ({
          title: `${article.source}: ${article.title}`,
          url: article.url
        })),
        { title: "Polymarket live markets", url: "https://polymarket.com/" }
      ],
      meta: {
        oil: oilSignal,
        polymarket: {
            source: polymarketSignal.source,
            matchedMarkets: polymarketSignal.matchedMarkets
        }
        }
    });
  } catch (error) {
    console.error("Scenario assessment failed:", error);
    return json(res, 500, {
      error: "scenario_assessment_failed",
      message: error.message
    });
  }
}


