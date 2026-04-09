import {
  getSavedSources,
  saveSource,
  deleteSource,
  updateSource
} from "../lib/source-store.js";

function getAllowedOrigin(req) {
  const requestOrigin = req.headers.origin || "";
  const configured = String(process.env.ALLOWED_ORIGIN || "").trim();

  if (!configured) return "*";
  if (configured === "*") return "*";
  if (requestOrigin && requestOrigin === configured) return configured;

  return configured;
}

function setCors(req, res) {
  const origin = getAllowedOrigin(req);
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(req, res, status, body) {
  setCors(req, res);
  res.status(status).setHeader("Content-Type", "application/json");
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
  const topic = req.query.topic || "iran";

  if (req.method === "OPTIONS") {
    return json(req, res, 200, { ok: true });
  }

  try {
    if (req.method === "GET") {
      const sources = await getSavedSources(topic);
      return json(req, res, 200, sources);
    }

    if (req.method === "POST") {
      const body = parseBody(req);

      if (!body.name || !body.url) {
        return json(req, res, 400, {
          error: "invalid_source",
          message: "name and url are required"
        });
      }

      const next = await saveSource(
        {
          name: body.name,
          url: body.url,
          type: body.type || "rss",
          enabled: body.enabled !== false,
          homepage: body.homepage || "",
          confidence: Number(body.confidence || 0),
          discovered_by: body.discovered_by || "manual",
          validated_at: body.validated_at || null
        },
        topic
      );

      return json(req, res, 200, { ok: true, sources: next });
    }

    if (req.method === "PATCH") {
      const body = parseBody(req);

      if (!body.id) {
        return json(req, res, 400, { error: "missing_id" });
      }

      const next = await updateSource(
        body.id,
        {
          name: body.name,
          url: body.url,
          type: body.type,
          enabled: body.enabled,
          homepage: body.homepage,
          confidence: body.confidence,
          discovered_by: body.discovered_by,
          validated_at: body.validated_at
        },
        topic
      );

      return json(req, res, 200, { ok: true, sources: next });
    }

    if (req.method === "DELETE") {
      const body = parseBody(req);

      if (!body.id) {
        return json(req, res, 400, { error: "missing_id" });
      }

      const next = await deleteSource(body.id, topic);
      return json(req, res, 200, { ok: true, sources: next });
    }

    return json(req, res, 405, { error: "method_not_allowed" });
  } catch (error) {
    return json(req, res, 500, {
      error: "sources_api_failed",
      message: error.message
    });
  }
}