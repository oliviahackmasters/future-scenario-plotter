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
  const response = await fetch(url, {
    headers: { Accept: "application/json" }
  });

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