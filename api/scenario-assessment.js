import Parser from "rss-parser";
import OpenAI from "openai";
import { getMergedSavedSources } from "../lib/source-store.js";

const parser = new Parser();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const RSS_FETCH_TIMEOUT_MS = 8000;
const JSON_FETCH_TIMEOUT_MS = 8000;
const OPENAI_TIMEOUT_FALLBACK_MS = 45000;
const MAX_ITEMS_PER_FEED = 6;
const MAX_ARTICLES_FOR_MODEL = 3;
const MAX_FILTERED_ITEMS = 5;
const MIN_MATCHES_REQUIRED = 2;

const TOPICS = {
  iran: {
    label: "Iran",
    scenarios: [
      {
        name: "Chaos + Collapse",
        description: "Multi-state regional war and a dysfunctional government in Iran.",
        gccReality:
          "Extreme security volatility, refugee flows, cross-border instability, oil system shock, and global recession risk.",
        scenarioSignals: [
          "loss of central command in Iran",
          "multiple armed factions emerge",
          "war spills across Iraq, Lebanon, and the Gulf simultaneously"
        ]
      },
      {
        name: "Shattered Diplomacy",
        description:
          "Security threat reduces in the short term, but long-term uncertainty rises through ungoverned spaces in Iran and militia proliferation.",
        gccReality:
          "Security threat reduces short term but long-term uncertainty rises through ungoverned spaces in Iran and militias.",
        scenarioSignals: [
          "leadership fractures",
          "internal uprising or regime weakening",
          "reduced coordination of external attacks"
        ]
      },
      {
        name: "Burning Strait",
        description:
          "The Gulf becomes an active war theatre, with severe energy-export disruption and mounting internal stability pressure.",
        gccReality:
          "Active war theatre, energy exports severely disrupted, civil defence activation, and internal stability pressures.",
        scenarioSignals: [
          "long-term Hormuz closure",
          "direct GCC military retaliation",
          "large-scale infrastructure strikes"
        ]
      },
      {
        name: "Cold Containment",
        description:
          "Managed escalation with constant security pressure, rising defence costs, and disrupted but still functioning oil flows.",
        gccReality:
          "Constant security pressure, rising defence costs, economic resilience but slow growth.",
        scenarioSignals: [
          "repeated ceasefire attempts",
          "limited symbolic retaliation",
          "oil flows disrupted but not halted"
        ]
      }
    ],
    trackedSignals: [
      "oil prices",
      "oil flows",
      "troop deployment",
      "government stability",
      "leadership fractures",
      "central command cohesion",
      "diplomacy / ceasefire",
      "maritime disruption",
      "infrastructure strikes",
      "protests / internal uprising",
      "external attack coordination",
      "armed faction emergence",
      "regional spillover",
      "prediction market odds"
    ],
    sources: [
      { name: "BBC Middle East", url: "http://feeds.bbci.co.uk/news/world/middle_east/rss.xml" },
      { name: "FT Oil", url: "https://www.ft.com/oil?format=rss" },
      { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
      { name: "FT Energy", url: "https://www.ft.com/energy?format=rss" },
      { name: "Guardian World", url: "https://www.theguardian.com/world/rss" }
    ],
    keywordFilter: [
      "iran",
      "tehran",
      "strait of hormuz",
      "hormuz",
      "gulf",
      "gcc",
      "israel",
      "iraq",
      "lebanon",
      "militia",
      "militias",
      "troops",
      "oil",
      "oil flows",
      "energy",
      "refugee",
      "ceasefire",
      "retaliation",
      "infrastructure",
      "airstrike",
      "missile",
      "uprising",
      "leadership",
      "regime",
      "command",
      "factions",
      "shipping",
      "sanctions",
      "strike",
      "drone",
      "attack",
      "naval",
      "seizure",
      "port",
      "explosion",
      "power plant",
      "tankers",
      "kharg"
    ],
    polymarketSearchTerms: ["iran", "hormuz", "middle east war", "israel iran"]
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

function startTimer(label) {
  return { label, startedAt: Date.now() };
}

function endTimer(timer) {
  if (!timer || !timer.label || !timer.startedAt) return;
  const ms = Date.now() - timer.startedAt;
  console.log(`${timer.label}: ${ms.toFixed(1)}ms`);
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeoutId)
  };
}

async function fetchText(url, init = {}, timeoutMs = RSS_FETCH_TIMEOUT_MS) {
  const { signal, clear } = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal,
      headers: {
        "User-Agent": "future-scenario-predictor/1.0",
        Accept: "application/rss+xml, application/xml, text/xml, application/atom+xml, text/plain, */*",
        ...(init.headers || {})
      }
    });

    if (!res.ok) {
      throw new Error(`Fetch failed ${res.status} for ${url}`);
    }

    return await res.text();
  } finally {
    clear();
  }
}

async function fetchJson(url, init = {}, timeoutMs = JSON_FETCH_TIMEOUT_MS) {
  const { signal, clear } = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal,
      headers: {
        "User-Agent": "future-scenario-predictor/1.0",
        Accept: "application/json",
        ...(init.headers || {})
      }
    });

    if (!res.ok) {
      throw new Error(`Fetch failed ${res.status} for ${url}`);
    }

    return await res.json();
  } finally {
    clear();
  }
}

function dedupeBy(items, getKey) {
  return Array.from(new Map(items.map((item) => [getKey(item), item])).values());
}

function isStrongIranMatch(item) {
  const title = String(item.title || "").toLowerCase();
  const snippet = String(item.contentSnippet || "").toLowerCase();
  const haystack = `${title} ${snippet}`;

  const directIranTerms = [
    "iran",
    "tehran",
    "iranian",
    "hormuz",
    "strait of hormuz",
    "persian gulf",
    "kharg"
  ];

  const regionalContextTerms = [
    "israel",
    "lebanon",
    "iraq",
    "gcc",
    "gulf",
    "oil",
    "energy",
    "shipping",
    "tankers",
    "missile",
    "drone",
    "ceasefire",
    "retaliation",
    "militia",
    "strike",
    "attack"
  ];

  const directHits = directIranTerms.filter((term) => haystack.includes(term)).length;
  const contextHits = regionalContextTerms.filter((term) => haystack.includes(term)).length;

  if (directHits >= 1) return true;
  if (title.includes("hormuz")) return true;
  if (title.includes("iran") && contextHits >= 1) return true;

  return false;
}

function scoreAndSort(items, savedSourceNames = []) {
  return items
    .map((item) => {
      const haystack = `${item.title} ${item.contentSnippet}`.toLowerCase();

      let matches = 0;
      for (const keyword of item.keywords || []) {
        if (haystack.includes(keyword)) matches += 1;
      }

      const savedBoost = savedSourceNames.includes(item.source) ? 0.75 : 0;
      const titleBoost = String(item.title || "").toLowerCase().includes("iran") ? 1 : 0;
      const score = matches + savedBoost + titleBoost;

      return { ...item, _matches: matches, _score: score };
    })
    .filter((item) => item._matches >= MIN_MATCHES_REQUIRED)
    .filter(isStrongIranMatch)
    .sort((a, b) => b._score - a._score || (b.isoDate || "").localeCompare(a.isoDate || ""));
}

async function fetchRssItems(source, keywordFilter) {
  try {
    const xml = await fetchText(source.url, {}, RSS_FETCH_TIMEOUT_MS);
    const feed = await parser.parseString(xml);
    const items = Array.isArray(feed.items) ? feed.items : [];

    console.log(
      `RAW FEED ITEMS FOR ${source.name}:`,
      items.slice(0, 3).map((item) => ({
        title: item.title,
        link: item.link,
        isoDate: item.isoDate || item.pubDate,
        snippet: (item.contentSnippet || item.summary || item.content || "").slice(0, 120)
      }))
    );

    return items.slice(0, MAX_ITEMS_PER_FEED).map((item) => ({
      source: source.name,
      url: item.link || source.url,
      title: normalizeWhitespace(item.title),
      contentSnippet: normalizeWhitespace(item.contentSnippet || item.summary || "").slice(0, 300),
      content: "",
      isoDate: item.isoDate || item.pubDate || null,
      keywords: keywordFilter
    }));
  } catch (error) {
    console.error(`Failed to fetch ${source.name}:`, error.message);
    return [];
  }
}

function ensureSavedSourcePresence(scoredItems, savedSourceNames = [], maxTotal = MAX_FILTERED_ITEMS) {
  const result = [];
  const usedUrls = new Set();

  for (const sourceName of savedSourceNames) {
    const match = scoredItems.find(
      (item) => item.source === sourceName && !usedUrls.has(item.url)
    );
    if (match) {
      result.push(match);
      usedUrls.add(match.url);
    }
  }

  for (const item of scoredItems) {
    if (result.length >= maxTotal) break;
    if (!usedUrls.has(item.url)) {
      result.push(item);
      usedUrls.add(item.url);
    }
  }

  return result.slice(0, maxTotal);
}

async function collectTopicCoverage(topicConfig, savedSources = []) {
  const defaultSources = Array.isArray(topicConfig.sources) ? topicConfig.sources : [];
  const extraSources = Array.isArray(savedSources)
    ? savedSources.filter((s) => s.enabled !== false)
    : [];

  const allSources = [...defaultSources, ...extraSources];

  const uniqueSources = Array.from(
    new Map(
      allSources.map((source) => [
        String(source.url || "").trim().toLowerCase(),
        {
          name: source.name,
          url: source.url,
          type: source.type || "rss",
          enabled: source.enabled !== false
        }
      ])
    ).values()
  ).filter((source) => source.url);

  const rssSources = uniqueSources.filter(
    (source) => String(source.type || "rss").toLowerCase() === "rss"
  );

  console.log("DEFAULT SOURCES:", defaultSources.map((s) => s.name));
  console.log(
    "SAVED SOURCES:",
    extraSources.map((s) => ({
      name: s.name,
      url: s.url,
      type: s.type,
      enabled: s.enabled
    }))
  );
  console.log(
    "RSS SOURCES USED:",
    rssSources.map((s) => ({
      name: s.name,
      url: s.url,
      type: s.type
    }))
  );

  const itemGroups = await Promise.all(
    rssSources.map((source) => fetchRssItems(source, topicConfig.keywordFilter))
  );

  const flattened = itemGroups.flat();
  const dedupedByUrl = dedupeBy(flattened, (item) => item.url);

  console.log(
    "FETCHED ARTICLE COUNTS BY SOURCE:",
    dedupedByUrl.reduce((acc, item) => {
      acc[item.source] = (acc[item.source] || 0) + 1;
      return acc;
    }, {})
  );

  const savedSourceNames = extraSources.map((s) => s.name);
  const scored = scoreAndSort(dedupedByUrl, savedSourceNames);

  console.log(
    "TOP 20 SCORED SOURCES:",
    scored.slice(0, 20).map((item) => ({
      source: item.source,
      title: item.title,
      matches: item._matches,
      score: item._score
    }))
  );

  const filtered = ensureSavedSourcePresence(scored, savedSourceNames, MAX_FILTERED_ITEMS);
  const shortlisted = filtered.slice(0, MAX_ARTICLES_FOR_MODEL);

  console.log(
    "FINAL FILTERED SOURCES:",
    shortlisted.map((item) => ({
      source: item.source,
      title: item.title
    }))
  );

  return shortlisted.map((item) => ({
    source: item.source,
    url: item.url,
    title: item.title,
    published_at: item.isoDate,
    snippet: String(item.contentSnippet || "").slice(0, 220)
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
        confidence: "Low",
        sources: []
      }
    };
  }

  try {
    const url = `https://www.alphavantage.co/query?function=BRENT&interval=monthly&apikey=${encodeURIComponent(apiKey)}`;
    const data = await fetchJson(url, {}, JSON_FETCH_TIMEOUT_MS);
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
        confidence,
        sources: []
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
        confidence: "Low",
        sources: []
      }
    };
  }
}

function scorePolymarketScenario(question, yesPrice) {
  const q = String(question || "").toLowerCase();
  const p = Number(yesPrice || 0);

  if (
    q.includes("hormuz") ||
    q.includes("shipping") ||
    q.includes("gulf war") ||
    q.includes("regional war") ||
    (q.includes("iran") && q.includes("israel") && q.includes("war")) ||
    q.includes("gcc retaliation") ||
    q.includes("infrastructure strike")
  ) {
    return { scenario: "Burning Strait", weight: p };
  }

  if (
    q.includes("regime collapse") ||
    q.includes("government collapse") ||
    q.includes("iran collapse") ||
    q.includes("supreme leader removed") ||
    q.includes("multiple factions") ||
    q.includes("civil war") ||
    q.includes("state failure")
  ) {
    return { scenario: "Chaos + Collapse", weight: p };
  }

  if (
    q.includes("deal") ||
    q.includes("ceasefire") ||
    q.includes("talks") ||
    q.includes("negotiation") ||
    q.includes("limited retaliation")
  ) {
    return { scenario: "Cold Containment", weight: 1 - p };
  }

  if (
    q.includes("fragmentation") ||
    q.includes("leadership fracture") ||
    q.includes("power vacuum") ||
    q.includes("militia") ||
    q.includes("ungoverned")
  ) {
    return { scenario: "Shattered Diplomacy", weight: p };
  }

  return null;
}

async function fetchPolymarketSignal(topicConfig) {
  try {
    const markets = await fetchJson("https://gamma-api.polymarket.com/markets", {}, JSON_FETCH_TIMEOUT_MS);
    const active = Array.isArray(markets) ? markets : [];

    const filtered = active
      .filter((m) => m.active && !m.closed)
      .filter((m) => {
        const text = `${m.question || ""} ${m.description || ""} ${(m.events || [])
          .map((e) => e.title || "")
          .join(" ")}`.toLowerCase();

        return topicConfig.polymarketSearchTerms.some((term) => text.includes(term));
      })
      .slice(0, 20);

    const weights = new Map([
      ["Chaos + Collapse", 0],
      ["Shattered Diplomacy", 0],
      ["Burning Strait", 0],
      ["Cold Containment", 0]
    ]);

    const matchedMarkets = [];

    for (const market of filtered) {
      let outcomePrices = [];

      if (Array.isArray(market.outcomePrices)) {
        outcomePrices = market.outcomePrices;
      } else if (typeof market.outcomePrices === "string") {
        try {
          outcomePrices = JSON.parse(market.outcomePrices || "[]");
        } catch {
          outcomePrices = [];
        }
      }

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
        confidence: matchedMarkets.length >= 3 ? "Medium" : "Low",
        sources: []
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
        confidence: "Low",
        sources: []
      }
    };
  }
}

function buildPrompt(topicConfig, articles, externalSignals) {
  const compactArticles = articles.map((a) => ({
    source: a.source,
    title: a.title,
    url: a.url,
    published_at: a.published_at,
    snippet: a.snippet
  }));

  const compactSignals = externalSignals.map((s) => ({
    source: s.source,
    signal: s.signal,
    weights: s.weights || undefined,
    matchedMarkets: Array.isArray(s.matchedMarkets)
      ? s.matchedMarkets.slice(0, 5)
      : undefined
  }));

  return [
    `Assess the current geopolitical outlook for ${topicConfig.label}.`,
    "",
    "Use only the supplied articles and external signals.",
    "Do not invent facts.",
    "Use these exact scenario names:",
    "Chaos + Collapse",
    "Shattered Diplomacy",
    "Burning Strait",
    "Cold Containment",
    "",
    "Return JSON matching the schema.",
    "",
    "Tracked signals:",
    JSON.stringify(topicConfig.trackedSignals),
    "",
    "Scenario definitions:",
    JSON.stringify(
      topicConfig.scenarios.map((s) => ({
        name: s.name,
        description: s.description,
        gccReality: s.gccReality,
        scenarioSignals: s.scenarioSignals
      }))
    ),
    "",
    "Articles:",
    JSON.stringify(compactArticles),
    "",
    "External signals:",
    JSON.stringify(compactSignals)
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
          },
          sources: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                url: { type: "string" },
                source: { type: "string" }
              },
              required: ["title", "url", "source"]
            }
          }
        },
        required: ["name", "reading", "direction", "confidence", "sources"]
      }
    },
    calculation: {
      type: "object",
      additionalProperties: false,
      properties: {
        scenarios: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              ai_score: { type: "number" },
              market_boost: { type: "number" },
              final_score: { type: "number" },
              reasoning: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    signal: { type: "string" },
                    effect: { type: "string" },
                    weight: { type: "string" },
                    sources: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          title: { type: "string" },
                          url: { type: "string" },
                          source: { type: "string" }
                        },
                        required: ["title", "url", "source"]
                      }
                    }
                  },
                  required: ["signal", "effect", "weight", "sources"]
                }
              }
            },
            required: ["name", "ai_score", "market_boost", "final_score", "reasoning"]
          }
        }
      },
      required: ["scenarios"]
    }
  },
  required: ["summary", "scenarios", "signals", "calculation"]
};

function normalizeScenarioScores(output, scenariosFromConfig, polymarketWeights = {}) {
  const byName = new Map(
    output.scenarios.map((item) => [String(item.name || "").trim().toLowerCase(), item])
  );

  const merged = scenariosFromConfig.map((scenario) => {
    const found = byName.get(scenario.name.toLowerCase());
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
      scenarios: topicConfig.scenarios.map((scenario) => ({
        ...scenario,
        score: 25
      })),
      signals: topicConfig.trackedSignals.map((signal) => ({
        name: signal,
        reading: "No recent evidence available in current fetch.",
        direction: "neutral",
        confidence: "Low",
        sources: []
      })),
      calculation: {
        scenarios: topicConfig.scenarios.map((scenario) => ({
          name: scenario.name,
          ai_score: 0,
          market_boost: 0,
          final_score: 25,
          reasoning: []
        }))
      }
    };
  }

  const prompt = buildPrompt(topicConfig, articles, externalSignals);

  let response;
  try {
    response = await Promise.race([
      openai.responses.create({
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
                text: prompt
              }
            ]
          }
        ],
        max_output_tokens: 2200,
        text: {
          format: {
            type: "json_schema",
            name: "scenario_assessment",
            schema: responseSchema,
            strict: true
          }
        }
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`OpenAI request exceeded ${OPENAI_TIMEOUT_FALLBACK_MS}ms.`)),
          OPENAI_TIMEOUT_FALLBACK_MS
        )
      )
    ]);
  } catch (error) {
    console.error("OpenAI scenario generation failed:", error.message);

    const polymarket = externalSignals.find((s) => s.source === "Polymarket");
    const fallbackScenarios = normalizeScenarioScores(
      {
        scenarios: topicConfig.scenarios.map((scenario, index) => ({
          name: scenario.name,
          description: scenario.description,
          score: index === 0 ? 15 : index === 1 ? 20 : index === 2 ? 35 : 30
        }))
      },
      topicConfig.scenarios,
      polymarket?.weights || {}
    );

    const fallbackSignals = topicConfig.trackedSignals.map((signalName) => {
      const externalMatch = externalSignals.find((s) => s.signal?.name === signalName);
      if (externalMatch?.signal) return externalMatch.signal;

      const supportingArticles = articles
        .filter((a) => {
          const haystack = `${a.title} ${a.snippet}`.toLowerCase();
          return haystack.includes(signalName.toLowerCase().split(" ")[0]);
        })
        .slice(0, 2)
        .map((a) => ({
          title: a.title,
          url: a.url,
          source: a.source
        }));

      return {
        name: signalName,
        reading: supportingArticles.length
          ? "Relevant reporting exists in the supplied articles, but the model response timed out."
          : "No clear reading available from the current fetch.",
        direction: "neutral",
        confidence: "Low",
        sources: supportingArticles
      };
    });

    return {
      summary:
        "A fallback assessment was used because the model did not return in time. Current reporting still points to sustained regional security pressure, energy disruption risk, and uncertain diplomacy.",
      scenarios: fallbackScenarios,
      signals: fallbackSignals,
      calculation: {
        scenarios: topicConfig.scenarios.map((scenario) => {
          const finalScenario = fallbackScenarios.find((s) => s.name === scenario.name);
          return {
            name: scenario.name,
            ai_score: 0,
            market_boost: Number(polymarket?.weights?.[scenario.name] || 0) * 20,
            final_score: Number(finalScenario?.score || 0),
            reasoning: []
          };
        })
      }
    };
  }

  const parsed = JSON.parse(response.output_text);
  console.log("RAW MODEL OUTPUT:", JSON.stringify(parsed, null, 2));

  if (
    !parsed.scenarios ||
    !Array.isArray(parsed.scenarios) ||
    parsed.scenarios.every((s) => Number(s.score || 0) <= 0)
  ) {
    parsed.scenarios = topicConfig.scenarios.map((scenario, index) => ({
      name: scenario.name,
      description: scenario.description,
      score: index === 0 ? 15 : index === 1 ? 20 : index === 2 ? 35 : 30
    }));
  }

  const polymarket = externalSignals.find((s) => s.source === "Polymarket");
  const normalizedScenarios = normalizeScenarioScores(
    parsed,
    topicConfig.scenarios,
    polymarket?.weights || {}
  );

  const calculationScenarios = topicConfig.scenarios.map((scenario) => {
    const rawCalc = (parsed.calculation?.scenarios || []).find(
      (item) => String(item.name || "").trim().toLowerCase() === scenario.name.toLowerCase()
    );

    const normalized = normalizedScenarios.find(
      (item) => item.name.toLowerCase() === scenario.name.toLowerCase()
    );

    return {
      name: scenario.name,
      ai_score: Number(rawCalc?.ai_score || 0),
      market_boost: Number(
        rawCalc?.market_boost || Number(polymarket?.weights?.[scenario.name] || 0) * 20
      ),
      final_score: Number(normalized?.score || 0),
      reasoning: Array.isArray(rawCalc?.reasoning) ? rawCalc.reasoning : []
    };
  });

  const signals = Array.isArray(parsed.signals) ? [...parsed.signals] : [];
  for (const ext of externalSignals) {
    if (ext.signal?.name) upsertSignal(signals, ext.signal);
  }

  return {
    summary: parsed.summary,
    scenarios: normalizedScenarios,
    signals,
    calculation: {
      scenarios: calculationScenarios
    }
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
    const totalTimer = startTimer("scenario-assessment-total");

    const topic = req.query.topic || "iran";
    const topicConfig = getTopicConfig(topic);

    const savedSourcesTimer = startTimer("load-saved-sources");
    const savedSources = await getMergedSavedSources(topic);
    endTimer(savedSourcesTimer);

    console.log("TOPIC:", topic);
    console.log("SAVED SOURCES LOADED:", savedSources);

    const coverageTimer = startTimer("collect-topic-coverage");
    const articlesPromise = collectTopicCoverage(topicConfig, savedSources);

    const oilTimer = startTimer("fetch-oil-signal");
    const oilSignalPromise = fetchOilSignal().finally(() => endTimer(oilTimer));

    const polyTimer = startTimer("fetch-polymarket-signal");
    const polymarketSignalPromise = fetchPolymarketSignal(topicConfig).finally(() => endTimer(polyTimer));

    const articles = await articlesPromise;
    endTimer(coverageTimer);

    const [oilSignal, polymarketSignal] = await Promise.all([
      oilSignalPromise,
      polymarketSignalPromise
    ]);

    const externalSignals = [oilSignal, polymarketSignal];

    const assessmentTimer = startTimer("generate-assessment");
    const assessment = await generateScenarioAssessment(topicConfig, articles, externalSignals);
    endTimer(assessmentTimer);

    endTimer(totalTimer);

    return json(res, 200, {
      topic: topicConfig.label,
      updated_at: new Date().toISOString(),
      summary: assessment.summary,
      scenarios: assessment.scenarios,
      signals: assessment.signals,
      calculation: assessment.calculation,
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
        },
        saved_sources: savedSources,
        used_article_sources: [...new Set(articles.map((a) => a.source))]
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