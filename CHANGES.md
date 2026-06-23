# Custom Scenario Plotter fix (June 2026)

## Root cause confirmed

From Olivia's debug log (scenario_plotter_tavily_objects.log):
- All 10 Tavily articles had `published_at: null`, `isoDate: null`
- `isTooOldForEvidence()` treated null as too-old (line 953: `if (age === null) return true`)
- These articles were rejected at the evidence gate in scoreArticles (line 1454)
- The provider exemption at line 979 was skipping this check at collection
  time, but the same gate was being applied again unconditionally at scoring time

Additionally, the Tavily queries were running as general web search (no topic
or time_range parameter), surfacing 2018/2019 EU policy PDFs and observatory
pages rather than recent news articles relevant to the scenario.

## Two files changed

### lib/custom-scenario-assessment-handler.js

`isTooOldForEvidence`: null date now means "age unknown, do not penalise"
for Tavily articles. RSS null dates remain rejected (every real RSS item has
a pubDate field, so null means broken or very old). No change for dated
articles of either provider type.

`articleFreshnessMultiplier`: same provider-aware logic -- Tavily articles
with no date get a 0.4 multiplier (same as "recent but not fresh") so they
can still contribute evidence when entity/signal matching is strong.

### lib/tavily-search.js

Added `topic: "news"` and `days: 90` to general web search calls
(useDefaultDomains true, no explicit domain restriction). This matches the
handler's HARD_RECENCY_LIMIT_DAYS value and pushes Tavily toward recent
news articles rather than evergreen institutional pages and policy PDFs.
Domain-restricted queries are left unchanged.

## What to test

Re-run the Baltic Smart Mobility Network scenario. Expect to see:
- tavily_articles with actual published_at dates (not all null)
- selected_article_count > 0 (articles surviving the evidence gate)
- Fetch and selection still working correctly for RSS sources

If selected_article_count is still 0 after this fix, the next thing to
check is the entity/signal overlap scoring -- the second-chance classifier
may need the planner to have produced richer entities for this topic.
Send the debug output and I can diagnose further.
