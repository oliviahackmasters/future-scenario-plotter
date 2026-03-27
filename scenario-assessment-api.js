import express from "express";
import cors from "cors";
import Parser from "rss-parser";
import OpenAI from "openai";

const app = express();
const port = process.env.PORT || 8787;
const parser = new Parser();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(cors({
  origin: true,
}));

app.use(express.json());

const TOPICS = {
  iran: {
    label: "Iran",
    scenarios: [
      {
        name: "Chaos + Collapse",
        description: "Multi-state regional war and a dysfunctional government in Iran.",
      },
      {
        name: "Shattered Diplomacy",
        description: "Post-Iran fragmentation and multiple weak political actors.",
      },
      {
        name: "Burning Strait",
        description: "Full regional war with no major ideological change in Iran.",
      },
      {
        name: "Cold Containment",
        description: "Managed escalation with minimal or no ground troops.",
      },
    ],
    trackedSignals: [
      "oil prices",
      "troop deployment",
      "government stability",
      "diplomacy / ceasefire",
      "maritime disruption",
      "protests / elite fragmentation",
    ],
    sources: [
      {
        name: "BBC World",
        type: "rss",
        url: "http://feeds.bbci.co.uk/news/world/rss.xml",
      },
      {
        name: "BBC Middle East",
        type: "rss",
        url: "http://feeds.bbci.co.uk/news/world/middle_east/rss.xml",
      },
      {
        name: "Reuters World",
        type: "rss",
        url: "https://www.reutersagency.com/feed/?best-topics=world&post_type=best",
      },
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
      "sanctions",
    ],
  },
};

function getTopicConfig(topic) {
  return TOPICS[String(topic || "iran").toLowerCase()] || TOPICS.iran;
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
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
      keywords: keywordFilter,
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

  const scored = scoreAndSort(flattened);
const filtered = capPerSource(scored, 4).slice(0, 25);

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

function capPerSource(items, maxPerSource = 4) {
  const counts = new Map();
  const result = [];

  for (const item of items) {
    const count = counts.get(item.source) || 0;
    if (count < maxPerSource) {
      result.push(item);
      counts.set(item.source, count + 1);
    }
  }

  return result;
}

function buildPrompt(topicConfig, articles) {
  return [
    `You are a geopolitical scenario analyst.`,
    ``,
    `Topic: ${topicConfig.label}`,
    ``,
    `Tracked signals:`,
    ...topicConfig.trackedSignals.map((signal) => `- ${signal}`),
    ``,
    `Scenarios:`,
    ...topicConfig.scenarios.map((scenario, index) => `${index + 1}. ${scenario.name} = ${scenario.description}`),
    ``,
    `Tasks:`,
    `1. Read the supplied source summaries.`,
    `2. Extract only evidence relevant to the tracked signals.`,
    `3. Score each scenario from 0 to 100 based on the signals.`,
    `4. Normalize the scenario scores so the total equals 100.`,
    `5. Give a concise summary of the current assessment.`,
    `6. Do not invent facts. Distinguish evidence from inference.`,
    ``,
    `Return JSON matching the requested schema.`,
    ``,
    `Articles:`,
    JSON.stringify(articles, null, 2),
  ].join("\n");
}

const responseSchema = {
  name: "scenario_assessment",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: {
        type: "string",
      },
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
            description: { type: "string" },
          },
          required: ["name", "score", "description"],
        },
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
              enum: ["rising", "stable", "falling"],
            },
            confidence: {
              type: "string",
              enum: ["Low", "Medium", "High"],
            },
          },
          required: ["name", "reading", "direction", "confidence"],
        },
      },
    },
    required: ["summary", "scenarios", "signals"],
  },
  strict: true,
};

function normalizeScenarioScores(output, scenariosFromConfig) {
  const byName = new Map(output.scenarios.map((item) => [item.name, item]));

  const merged = scenariosFromConfig.map((scenario) => {
    const found = byName.get(scenario.name);
    return {
      name: scenario.name,
      description: found?.description || scenario.description,
      score: Number(found?.score || 0),
    };
  });

  const rawTotal = merged.reduce((sum, item) => sum + item.score, 0);
  if (rawTotal <= 0) {
    const equalScore = Math.round(100 / merged.length);
    return merged.map((item, index) => ({
      ...item,
      score: index === merged.length - 1 ? 100 - equalScore * (merged.length - 1) : equalScore,
    }));
  }

  let running = 0;
  return merged.map((item, index) => {
    if (index === merged.length - 1) {
      return {
        ...item,
        score: Math.max(0, 100 - running),
      };
    }

    const normalized = Math.round((item.score / rawTotal) * 100);
    running += normalized;
    return {
      ...item,
      score: normalized,
    };
  });
}

async function generateScenarioAssessment(topicConfig, articles) {
  if (!articles.length) {
    return {
      summary: "Not enough current source material was available to generate a live assessment.",
      scenarios: topicConfig.scenarios.map((scenario, index) => ({
        ...scenario,
        score: index === 0 ? 25 : 25,
      })),
      signals: topicConfig.trackedSignals.map((signal) => ({
        name: signal,
        reading: "No recent evidence available in current fetch.",
        direction: "neutral",
        confidence: "Low",
      })),
    };
  }

  const prompt = buildPrompt(topicConfig, articles);

  const response = await openai.responses.create({
    model: "gpt-5.4",
    input: [
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: "Produce a concise geopolitical scenario assessment using only the supplied source material.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: prompt,
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: responseSchema.name,
        schema: responseSchema.schema,
        strict: true,
      },
    },
  });

  const parsed = JSON.parse(response.output_text);

  return {
    summary: parsed.summary,
    scenarios: normalizeScenarioScores(parsed, topicConfig.scenarios),
    signals: parsed.signals,
  };
}

app.get("/api/scenario-assessment", async (req, res) => {
  const topicConfig = getTopicConfig(req.query.topic);

  try {
    const articles = await collectTopicCoverage(topicConfig);
    const assessment = await generateScenarioAssessment(topicConfig, articles);

    res.json({
      topic: topicConfig.label,
      updated_at: new Date().toISOString(),
      summary: assessment.summary,
      scenarios: assessment.scenarios,
      signals: assessment.signals,
      sources: articles.map((article) => ({
        title: `${article.source}: ${article.title}`,
        url: article.url,
      })),
    });
  } catch (error) {
    console.error("Scenario assessment failed:", error);
    res.status(500).json({
      error: "scenario_assessment_failed",
      message: error.message,
    });
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`Scenario assessment API listening on port ${port}`);
});
