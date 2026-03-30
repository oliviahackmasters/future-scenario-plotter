import Parser from "rss-parser";
import OpenAI from "openai";
import { getMergedSavedSources } from "../lib/source-store.js";

const parser = new Parser();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });


const TOPICS = {
  iran: {
    label: "Iran",
    scenarios: [
      {
        name: "Chaos + Collapse",
        description: "Multi-state regional war and a dysfunctional government in Iran.",
        gccReality: "Extreme security volatility, refugee flows, cross-border instability, oil system shock, and global recession risk.",
        scenarioSignals: [
          "loss of central command in Iran",
          "multiple armed factions emerge",
          "war spills across Iraq, Lebanon, and the Gulf simultaneously"
        ]
      },
      {
        name: "Shattered Diplomacy",
        description: "Security threat reduces in the short term, but long-term uncertainty rises through ungoverned spaces in Iran and militia proliferation.",
        gccReality: "Security threat reduces short term but long-term uncertainty rises through ungoverned spaces in Iran and militias.",
        scenarioSignals: [
          "leadership fractures",
          "internal uprising or regime weakening",
          "reduced coordination of external attacks"
        ]
      },
      {
        name: "Burning Strait",
        description: "The Gulf becomes an active war theatre, with severe energy-export disruption and mounting internal stability pressure.",
        gccReality: "Active war theatre, energy exports severely disrupted, civil defence activation, and internal stability pressures.",
        scenarioSignals: [
          "long-term Hormuz closure",
          "direct GCC military retaliation",
          "large-scale infrastructure strikes"
        ]
      },
      {
        name: "Cold Containment",
        description: "Managed escalation with constant security pressure, rising defence costs, and disrupted but still functioning oil flows.",
        gccReality: "Constant security pressure, rising defence costs, economic resilience but slow growth.",
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
        { name: "BBC World", url: "http://feeds.bbci.co.uk/news/world/rss.xml" },
        { name: "BBC Middle East", url: "http://feeds.bbci.co.uk/news/world/middle_east/rss.xml" },
        { name: "Reuters World", url: "https://www.reutersagency.com/feed/?best-topics=world&post_type=best" },
        { name: "FT Markets", url: "https://www.ft.com/markets?format=rss" },
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

async function collectTopicCoverage(topicConfig, savedSources = []) {
  const allSources = [
    ...topicConfig.sources,
    ...savedSources.filter((s) => s.enabled !== false)
  ];

  const uniqueSources = Array.from(
    new Map(allSources.map((source) => [source.url, source])).values()
  );

  const rssSources = uniqueSources.filter((source) => source.type === "rss" || !source.type);

  console.log("RSS SOURCES USED:", rssSources.map(s => ({
    name: s.name,
    url: s.url,
    type: s.type || "rss"
  })));

  const itemGroups = await Promise.all(
    rssSources.map((source) => fetchRssItems(source, topicConfig.keywordFilter))
  );

  const flattened = itemGroups.flat();

  console.log(
    "FETCHED ARTICLE COUNTS BY SOURCE:",
    flattened.reduce((acc, item) => {
      acc[item.source] = (acc[item.source] || 0) + 1;
      return acc;
    }, {})
  );

  const filtered = scoreAndSort(flattened).slice(0, 15);

  console.log(
    "FINAL FILTERED SOURCES:",
    filtered.map(item => item.source)
  );

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
    ...topicConfig.scenarios.map(
      (scenario, index) =>
        `${index + 1}. ${scenario.name} = ${scenario.description} GCC reality: ${scenario.gccReality}. Key scenario signals: ${scenario.scenarioSignals.join(", ")}.`
    ),
    "Use these exact scenario names in the scenarios array and calculation array:",
    "- Chaos + Collapse",
    "- Shattered Diplomacy",
    "- Burning Strait",
    "- Cold Containment",
    "",
    "Tasks:",
    "1. Read the supplied source summaries.",
    "2. Extract only evidence relevant to the tracked signals.",
    "3. Score each scenario from 0 to 100 based on the signals.",
    "4. Normalize the scenario scores so the total equals 100.",
    "5. Give a concise summary of the current assessment.",
    "6. Do not invent facts. Distinguish evidence from inference.",
    "7. For each tracked signal, include 1 to 3 supporting source items from the supplied articles.",
    "8. Only cite supplied articles as sources for signal-level evidence.",
    "9. For each signal source, return title, url, and source name.",
    "10. Use the structured external signals as additional context, especially for oil prices and prediction market odds.",
    "11. If narrative reporting and external signals conflict, mention that in the summary or relevant signal reading.",
    "12. Treat direct oil-market reporting from Financial Times as a preferred narrative source for the oil prices signal.",
    "13. Interpret each scenario through the GCC lens given in the scenario definitions.",
    "14. Pay close attention to whether oil flows are disrupted versus fully halted.",
    "15. Distinguish between regime weakening, leadership fractures, and full loss of central command.",
    "16. Distinguish between limited symbolic retaliation and direct GCC military retaliation.",
    "Output requirements:",
    "",
    "- Return valid JSON matching the required schema.",
    "- Every signal must include: name, reading, direction, confidence, and sources.",
    "- sources must be an array of objects with title, url, and source.",
    "- Do not include sources that are not present in the supplied articles list.",
    "- Include a calculation object.",
    "- For each scenario, include ai_score, market_boost, final_score, and reasoning.",
    "- In reasoning, explain which signals affected the scenario, whether they increased or decreased it, how strongly they mattered, and which supplied sources supported that judgment.",
    "- Use only supplied articles as sources in reasoning.",
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
    market_boost: Number(rawCalc?.market_boost || Number(polymarket?.weights?.[scenario.name] || 0) * 20),
    final_score: Number(normalized?.score || 0),
    reasoning: Array.isArray(rawCalc?.reasoning) ? rawCalc.reasoning : []
  };
});

  const signals = [...parsed.signals];
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
    const topicConfig = getTopicConfig(req.query.topic);

    const savedSources = await getMergedSavedSources(req.query.topic || "iran");

const [articles, oilSignal, polymarketSignal] = await Promise.all([
  collectTopicCoverage(topicConfig, savedSources),
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
    saved_sources: savedSources
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


