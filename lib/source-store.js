import { kv } from "@vercel/kv";

const memoryStore = new Map();
const GLOBAL_SOURCES_KEY = "scenario:sources:global";

function hasKv() {
  return !!process.env.KV_REST_API_URL && !!process.env.KV_REST_API_TOKEN;
}

function normalizeTopic(topic) {
  return String(topic || "global").trim().toLowerCase();
}

function topicKey(topic) {
  return `scenario:sources:${normalizeTopic(topic)}`;
}

async function getStoreValue(key) {
  if (hasKv()) return (await kv.get(key)) || [];
  return memoryStore.get(key) || [];
}

async function setStoreValue(key, value) {
  if (hasKv()) {
    await kv.set(key, value);
    return;
  }
  memoryStore.set(key, value);
}

export async function getSavedSources(topic = "global") {
  const [globalSources, topicSources] = await Promise.all([
    getStoreValue(GLOBAL_SOURCES_KEY),
    getStoreValue(topicKey(topic))
  ]);

  return {
    global: Array.isArray(globalSources) ? globalSources : [],
    topic: Array.isArray(topicSources) ? topicSources : []
  };
}

export async function getMergedSavedSources(topic = "global") {
  const { global, topic: topicSpecific } = await getSavedSources(topic);
  return [...global, ...topicSpecific];
}

export async function saveSource(source, topic = "global") {
  const key = topicKey(topic);
  const current = await getStoreValue(key);

  const id = source.id || crypto.randomUUID();

  const next = [
    ...current.filter((item) => item.id !== id),
    {
      id,
      name: String(source.name || "").trim(),
      url: String(source.url || "").trim(),
      type: String(source.type || "rss").trim().toLowerCase(),
      enabled: source.enabled !== false,
      created_at: source.created_at || new Date().toISOString()
    }
  ];

  await setStoreValue(key, next);
  return next;
}

export async function deleteSource(id, topic = "global") {
  const key = topicKey(topic);
  const current = await getStoreValue(key);
  const next = current.filter((item) => item.id !== id);
  await setStoreValue(key, next);
  return next;
}

export async function updateSource(id, updates, topic = "global") {
  const key = topicKey(topic);
  const current = await getStoreValue(key);

  const next = current.map((item) =>
    item.id === id ? { ...item, ...updates, id: item.id } : item
  );

  await setStoreValue(key, next);
  return next;
}