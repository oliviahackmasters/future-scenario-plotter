# Custom Scenario Plotter Embed

This embed is a topic-agnostic subset of the scenario plotter. Users enter 1-4 scenarios and signals, select or deselect RSS sources, then request a likelihood assessment.

## Squarespace embed code

Replace `https://YOUR-VERCEL-DOMAIN.vercel.app` with the deployed scenario plotter domain.

```html
<div style="width:100%;max-width:980px;margin:0 auto;">
  <iframe
    src="https://YOUR-VERCEL-DOMAIN.vercel.app/custom-scenario-embed.html?api=https://YOUR-VERCEL-DOMAIN.vercel.app"
    style="width:100%;height:900px;border:0;background:#050505;"
    loading="lazy"
    title="Custom Scenario Plotter"
  ></iframe>
</div>
```

## Endpoint

`POST /api/custom-scenario-assessment`

Payload:

```json
{
  "scenarios": [
    {
      "name": "Scenario name",
      "description": "Scenario description",
      "signals": ["signal one", "signal two"]
    }
  ],
  "sources": [
    {
      "id": "bbc-world",
      "name": "BBC World",
      "url": "http://feeds.bbci.co.uk/news/world/rss.xml",
      "reliability": 82,
      "enabled": true
    }
  ]
}
```

The response includes `scenario_scores`, `sources_used`, `failed_sources`, and `evidence_articles`.

## Notes

- The endpoint uses selected RSS sources only.
- Source reliability is a 0-100 percentage.
- The model reports source relevance and combines it with reliability as a source weighting percentage.
- If `OPENAI_API_KEY` is missing, or no relevant articles are found, the endpoint falls back to a heuristic signal-match estimate.
- Existing hardcoded topic endpoints remain unchanged.
