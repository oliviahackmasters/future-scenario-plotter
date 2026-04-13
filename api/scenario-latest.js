import { loadLatestAssessment, loadAssessmentHistory } from "../lib/blob-store.js";

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.send(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return json(res, 200, { ok: true });
  }

  if (req.method !== "GET") {
    return json(res, 405, { error: "method_not_allowed" });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return json(res, 500, {
      error: "missing_blob_config",
      message: "BLOB_READ_WRITE_TOKEN is not set."
    });
  }

  try {
    const topic = req.query.topic || "iran";

    const [latest, history] = await Promise.all([
      loadLatestAssessment(topic),
      loadAssessmentHistory(topic)
    ]);

    if (!latest) {
      return json(res, 404, {
        error: "no_cached_assessment",
        message: `No cached assessment found for topic "${topic}".`
      });
    }

    return json(res, 200, {
      ...latest,
      history: Array.isArray(history) ? history.slice(-30) : []
    });
  } catch (error) {
    console.error("scenario-latest failed:", error);
    return json(res, 500, {
      error: "scenario_latest_failed",
      message: error.message
    });
  }
}