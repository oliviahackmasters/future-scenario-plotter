import { createClient } from "redis";

const GLOBAL_SOURCES_KEY = "scenario:sources:global";

function normalizeTopic(topic) {
  return String(topic || "global").trim().toLowerCase();
}

function topicKey(topic) {
  return `scenario:sources:${normalizeTopic(topic)}`;
}

function isRedisConfigured() {
  return !!process.env.REDIS_URL;
}

function getPublicBaseUrl() {
  const raw = process.env.PUBLIC_BASE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "";
  if (!raw) return "";
  return raw.startsWith("http") ? raw.replace(/\/$/, "") : `https://${raw.replace(/\/$/, "")}`;
}

function buildTavilyBridgeSources(topic = "global") {
  const baseUrl = getPublicBaseUrl();
  if (!baseUrl || !process.env.TAVILY_API_KEY) return [];

  const encodedTopic = encodeURIComponent(normalizeTopic(topic));
  const domains = [
    { id: "tavily-reuters", name: "Reuters Web Search", domain: "reuters.com", confidence: 84 },
    { id: "tavily-reddit", name: "Reddit Web Search", domain: "reddit.com", confidence: 55 },
    { id: "tavily-substack", name: "Substack Web Search", domain: "substack.com", confidence: 60 },
    { id: "tavily-bellingcat", name: "Bellingcat Web Search", domain: "bellingcat.com", confidence: 82 },
    { id: "tavily-x", name: "X Web Search", domain: "x.com", confidence: 45 },
    { id: "tavily-twitter", name: "Twitter Web Search", domain: "twitter.com", confidence: 45 },
    { id: "tavily-threads", name: "Threads Web Search", domain: "threads.net", confidence: 45 }
  ];

  return domains.map((source) => ({
    id: `${source.id}-${encodedTopic}`,
    name: source.name,
    url: `${baseUrl}/api/tavily-rss?topic=${encodedTopic}&domain=${encodeURIComponent(source.domain)}`,
    type: "rss",
    enabled: true,
    homepage: `https://${source.domain}`,
    confidence: source.confidence,
    discovered_by: "tavily",
    validated_at: new Date().toISOString(),
    created_at: new Date().toISOString()
  }));
}

let redisClientPromise = null;

async function getRedis() {
  if (!isRedisConfigured()) {
    throw new Error("Redis is not configured. Missing REDIS_URL.");
  }

  if (!redisClientPromise) {
    const client = createClient({
      url: process.env.REDIS_URL
    });

    client.on("error", (err) => {
      console.error("Redis client error:", err);
    });

    redisClientPromise = client.connect().then(() => client);
  }

  return redisClientPromise;
}

function sanitizeSource(source = {}) {
  return {
    id: source.id || crypto.randomUUID(),
    name: String(source.name || "").trim(),
    url: String(source.url || "").trim(),
    type: String(source.type || "rss").trim().toLowerCase(),
    enabled: source.enabled !== false,
    homepage: String(source.homepage || "").trim(),
    confidence: Number(source.confidence || 0),
    discovered_by: String(source.discovered_by || "manual").trim(),
    validated_at: source.validated_at || null,
    created_at: source.created_at || new Date().toISOString()
  };
}

async function getJson(key) {
  const redis = await getRedis();
  const raw = await redis.get(key);

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function setJson(key, value) {
  const redis = await getRedis();
  await redis.set(key, JSON.stringify(value));
}

function isValidSavedSource(source = {}) {
  return Boolean(String(source.name || "").trim() && String(source.url || "").trim());
}

export async function getSavedSources(topic = "global") {
  if (!isRedisConfigured()) {
    return { global: [], topic: buildTavilyBridgeSources(topic) };
  }

  const [globalSources, topicSources] = await Promise.all([
    getJson(GLOBAL_SOURCES_KEY),
    getJson(topicKey(topic))
  ]);

  const sanitizeList = (list) =>
    Array.isArray(list)
      ? list.map(sanitizeSource).filter(isValidSavedSource)
      : [];

  return {
    global: sanitizeList(globalSources),
    topic: [
      ...sanitizeList(topicSources),
      ...buildTavilyBridgeSources(topic)
    ]
  };
}

export async function getMergedSavedSources(topic = "global") {
  const { global, topic: topicSpecific } = await getSavedSources(topic);
  return [...global, ...topicSpecific];
}

export async function saveSource(source, topic = "global") {
  if (!isRedisConfigured()) {
    throw new Error("Saved sources are unavailable because Redis is not configured.");
  }

  const key = topicKey(topic);
  const current = (await getJson(key)) || [];
  const nextItem = sanitizeSource(source);

  const next = [
    ...current.filter((item) => item.id !== nextItem.id),
    nextItem
  ];

  await setJson(key, next);
  return next;
}

export async function deleteSource(id, topic = "global") {
  if (!isRedisConfigured()) {
    throw new Error("Saved sources are unavailable because Redis is not configured.");
  }

  const key = topicKey(topic);
  const current = (await getJson(key)) || [];
  const next = current.filter((item) => item.id !== id);

  await setJson(key, next);
  return next;
}

export async function updateSource(id, updates, topic = "global") {
  if (!isRedisConfigured()) {
    throw new Error("Saved sources are unavailable because Redis is not configured.");
  }

  const key = topicKey(topic);
  const current = (await getJson(key)) || [];

  const next = current.map((item) =>
    item.id === id
      ? sanitizeSource({
          ...item,
          ...updates,
          id: item.id,
          created_at: item.created_at
        })
      : item
  );

  await setJson(key, next);
  return next;
}
