import {
  getSavedSources,
  saveSource,
  deleteSource,
  updateSource
} from "../lib/source-store.js";

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.send(JSON.stringify(body));
}

function parseBody(req) {
  if (typeof req.body === "object" && req.body !== null) return req.body;
  try {
    return JSON.parse(req.body || "{}");
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  const topic = req.query.topic || "global";

  if (req.method === "OPTIONS") {
    return json(res, 200, { ok: true });
  }

  try {
    if (req.method === "GET") {
      const sources = await getSavedSources(topic);
      return json(res, 200, sources);
    }

    if (req.method === "POST") {
      const body = parseBody(req);

      if (!body.name || !body.url) {
        return json(res, 400, {
          error: "invalid_source",
          message: "name and url are required"
        });
      }

      const next = await saveSource(
        {
          name: body.name,
          url: body.url,
          type: body.type || "rss",
          enabled: body.enabled !== false
        },
        topic
      );

      return json(res, 200, { ok: true, sources: next });
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);

      if (!body.id) {
        return json(res, 400, { error: "missing_id" });
      }

      const next = await updateSource(
        body.id,
        {
          name: body.name,
          url: body.url,
          type: body.type,
          enabled: body.enabled
        },
        topic
      );

      return json(res, 200, { ok: true, sources: next });
    }

    if (req.method === "DELETE") {
      const body = parseBody(req);

      if (!body.id) {
        return json(res, 400, { error: "missing_id" });
      }

      const next = await deleteSource(body.id, topic);
      return json(res, 200, { ok: true, sources: next });
    }

    return json(res, 405, { error: "method_not_allowed" });
  } catch (error) {
    return json(res, 500, {
      error: "sources_api_failed",
      message: error.message
    });
  }
}