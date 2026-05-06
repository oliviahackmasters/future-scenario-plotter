import { put, list } from "@vercel/blob";

function getTopicKey(topic) {
  return String(topic || "iran").toLowerCase().trim();
}

export function getLatestBlobPath(topic) {
  return `latest/${getTopicKey(topic)}.json`;
}

export function getHistoryBlobPath(topic) {
  return `history/${getTopicKey(topic)}.json`;
}

async function readJsonFromBlobUrl(url) {
  const headers = { Accept: "application/json" };

  if (process.env.BLOB_READ_WRITE_TOKEN) {
    headers.Authorization = `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`Failed to fetch blob JSON (${response.status})`);
  }

  return await response.json();
}

async function findBlobByPath(pathname) {
  const result = await list({
    prefix: pathname,
    limit: 10
  });

  return Array.isArray(result?.blobs)
    ? result.blobs.find((item) => item.pathname === pathname)
    : null;
}

function containsFallbackTimeoutText(value) {
  const text = JSON.stringify(value || {}).toLowerCase();
  return text.includes("model request failed or timed out") ||
    text.includes("openai request timed out") ||
    text.includes("current reporting still points to sustained pressure") ||
    text.includes("fallback") && text.includes("timed out");
}

function hasDefaultFallbackScores(payload = {}) {
  const scores = Array.isArray(payload.scenario_scores)
    ? payload.scenario_scores
    : Array.isArray(payload.scenarios)
      ? payload.scenarios.map((scenario) => ({
          name: scenario.name,
          score: scenario.score
        }))
      : [];

  const byName = new Map(scores.map((item) => [
    String(item.name || item.scenario || "").toLowerCase(),
    Number(item.final_score ?? item.score ?? item.likelihood_percent ?? item.ai_score)
  ]));

  return Math.abs((byName.get("chaos + collapse") ?? -1) - 0.15) < 0.001 &&
    Math.abs((byName.get("shattered diplomacy") ?? -1) - 0.20) < 0.001 &&
    Math.abs((byName.get("burning strait") ?? -1) - 0.35) < 0.001 &&
    Math.abs((byName.get("cold containment") ?? -1) - 0.30) < 0.001;
}

function isFallbackAssessment(payload = {}) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.is_fallback === true || payload.fallback === true) return true;
  if (containsFallbackTimeoutText(payload)) return true;
  return hasDefaultFallbackScores(payload) && containsFallbackTimeoutText(payload);
}

export async function loadLatestAssessment(topic) {
  try {
    const pathname = getLatestBlobPath(topic);
    const blob = await findBlobByPath(pathname);

    if (!blob?.url) return null;

    return await readJsonFromBlobUrl(blob.url);
  } catch (error) {
    console.error("Failed to load latest assessment from Blob:", error.message);
    return null;
  }
}

export async function saveLatestAssessment(topic, payload) {
  if (isFallbackAssessment(payload)) {
    console.warn("Skipping latest assessment save because payload appears to be timeout/fallback output.");
    return payload;
  }

  const pathname = getLatestBlobPath(topic);

  await put(
    pathname,
    JSON.stringify(payload, null, 2),
    {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json"
    }
  );

  return payload;
}

export async function loadAssessmentHistory(topic) {
  try {
    const pathname = getHistoryBlobPath(topic);
    const blob = await findBlobByPath(pathname);

    if (!blob?.url) return [];

    const history = await readJsonFromBlobUrl(blob.url);

    if (!Array.isArray(history)) return [];

    return history
      .filter((item) => item && item.date && Array.isArray(item.scenario_scores))
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  } catch (error) {
    console.error("Failed to load assessment history from Blob:", error.message);
    return [];
  }
}

export async function saveAssessmentHistory(topic, entry) {
  const pathname = getHistoryBlobPath(topic);
  const existing = await loadAssessmentHistory(topic);

  if (isFallbackAssessment(entry)) {
    console.warn("Skipping history save because entry appears to be timeout/fallback output.");
    return existing;
  }

  const entryDate = String(entry.date || new Date().toISOString().slice(0, 10));
  const mergedEntry = {
    ...entry,
    date: entryDate,
    updated_at: entry.updated_at || new Date().toISOString()
  };

  const existingIndex = existing.findIndex((item) => item.date === entryDate);

  if (existingIndex >= 0) {
    existing[existingIndex] = {
      ...existing[existingIndex],
      ...mergedEntry
    };
  } else {
    existing.push(mergedEntry);
  }

  existing.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  await put(
    pathname,
    JSON.stringify(existing, null, 2),
    {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json"
    }
  );

  return existing;
}
