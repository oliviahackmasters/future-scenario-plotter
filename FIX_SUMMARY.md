# Custom Scenario Plotter — fix summary for Olivia

This replaces the earlier pre-meeting diagnostic (which was a reasonable
guess from the dev notes alone, but didn't have your actual code). After
reading `lib/custom-scenario-assessment-handler.js`, `lib/tavily-search.js`
and `lib/article-evidence-quality.js` directly, the real root cause is more
specific than "matching is too literal" — it's a chain of three things.

## Root cause (confirmed against your code, not guessed)

1. **`buildScenarioSearchPlan` silently returns empty `entities` /
   `geographies` / `industries` / `signals_to_track` whenever the OpenAI
   planner call fails** (timeout, API error — exactly the
   `planner_status: 'failed'` you captured in the debug trace). There's no
   retry and no degraded-but-useful fallback, just empty arrays.

2. **Those empty arrays make two gating functions effectively unsatisfiable
   for any scenario whose name isn't hardcoded.** `hasStrongRssTopicMatch`'s
   generic branch requires `entityHits >= 1 || signalHits >= 2`, both of
   which are sourced from those same arrays — when they're empty, that
   condition is always `false`, no matter how relevant the article is.
   `hasScenarioEntityOverlap` has a similar issue with its flat "RSS needs
   2 anchor hits" rule when the anchor vocabulary is thin.

3. **RSS and Tavily articles are held to very different bars.** Tavily
   articles skip `hasStrongRssTopicMatch` entirely and only need 1 entity
   hit instead of 2. That's why the one surviving article in your example
   came through "Web Search" (Tavily), not RSS — RSS was structurally
   locked out the moment the planner failed.

The deterministic scoring formula itself
(`computeScoreCalibrationForScenario`) is fine and doesn't need touching —
it's been starved by the gates above, not broken itself.

There's also a **fourth, narrower gap** I found by testing real candidate
articles against the code: even after fixing 1–3, an article that
paraphrases a signal without sharing any of the scenario's literal wording
(e.g. "young voters turning out in record numbers" vs. the signal "youth
turnout rises") still gets rejected at the entity-overlap stage, before
signal scoring ever runs. That one needs an LLM call to close, since no
keyword heuristic will generalise to arbitrary paraphrasing.

## What changed (see the diff)

`custom-scenario-assessment-handler.diff` is a full unified diff against
your current file. `custom-scenario-assessment-handler.js` is the complete
patched file, ready to use, but **diff it against your actual repo
yourself before deploying** — this was built and tested against the zip
you sent, so if you've made changes since, those need to be reconciled.

1. **Planner retry + heuristic fallback.** `buildScenarioSearchPlan` now
   tries a second model (`gpt-4o-mini` by default, override with
   `OPENAI_SEARCH_PLANNER_FALLBACK_MODEL`) if the first fails, with a
   shorter timeout budget for the retry (6s vs 12s) so total worst-case
   time stays bounded. If both fail, `entities`/`signals_to_track` are now
   populated by a cheap heuristic (proper-noun extraction from the
   scenario text) instead of being hard-empty.

2. **Entity-overlap gate scales to available vocabulary.** The flat
   "RSS needs 2 hits" rule now only applies when there's a reasonably-sized
   anchor vocabulary (>4 tokens); otherwise it drops to 1, since requiring
   2 hits from a 2-token vocabulary was nearly impossible.

3. **`hasStrongRssTopicMatch` no longer auto-fails when entity/signal
   vocab is empty.** Falls back to scenario-name/description token overlap
   alone (with a raised bar — 3 hits instead of 2 — to compensate for
   losing the second independent signal), instead of being unconditionally
   `false`.

4. **A real signal match can satisfy the RSS strength gate directly.**
   Previously `hasStrongRssTopicMatch` ran independently of whether
   `scoreItemAgainstSignals` already found a real, weighted match. Now if
   a signal matched via the `aliasSignalMatch` library, or 2+ signals
   matched, or a single high-weight (6/9) signal matched, that's accepted
   as sufficient on its own — a specific signal match is more reliable
   evidence than generic scenario-name overlap.

5. **New: batched, budget-capped LLM second-chance pass**
   (`secondChanceEntityOverlap`), closing gap #4 above. For each scenario,
   articles that fail the cheap entity-overlap gate (but are otherwise
   still viable — not too old, not a weak/explainer page) get ONE batched
   classification call asking "which of these are plausibly related to
   this scenario's signals, even if worded differently". This does NOT
   set or influence any likelihood score — it only unblocks articles from
   the entity gate so they go through the *exact same* downstream scoring
   as everything else. Capped at 20 articles per scenario per request,
   runs in parallel across scenarios (not sequentially), and on any
   failure (no API key, timeout, bad JSON) just returns no recoveries —
   the rest of the pipeline behaves exactly as before.

## What's verified vs. what needs your confirmation

**Verified, with real tests against your actual code** (not the LLM parts —
those need a live API key, see below):
- Built a test harness importing the real patched module and ran it
  against a reconstructed version of your "Democratic Hold" scenario plus
  a mix of real rejected articles from your debug trace and some
  plausible-but-differently-worded true positives.
- Confirmed obviously-irrelevant articles (Trump/Venezuela strike, Starmer
  arson, World Cup) are still correctly rejected — the fix isn't just
  loosening everything indiscriminately.
- Confirmed a previously-lost true positive ("Republican candidate drops
  out of Senate race after indictment", matched against "Republican
  candidate faces legal or campaign disruption") now correctly recovers
  and scores 7, where it previously scored 0.
- Confirmed the no-API-key fallback paths are fast (~14ms for 6 articles)
  and don't throw.

**Not verified — needs you to test with a real `OPENAI_API_KEY`:**
- The actual `secondChanceEntityOverlap` LLM call (prompt, schema,
  response parsing) — I verified the id-mapping logic in isolation with a
  simulated response, but couldn't make a real OpenAI call from this
  environment. Test this first with a cheap/small scenario before relying
  on it.
- The planner retry's second model attempt (`gpt-4o-mini`) — same reason.
- Recovery of "Young voters are turning out in record numbers" specifically
  requires the live second-chance LLM call; it's still rejected in the
  no-API-key test by design (correctly falls back to old behaviour rather
  than crashing).

## One thing to watch: function timeout budget

`vercel.json` sets `maxDuration: 60` for this endpoint. Worst-case timing
with these changes: planner (12s + 6s retry = 18s) + RSS/Tavily fetch
(parallelized, ~9s worst case) + second-chance pass (parallelized across
scenarios, ~10s worst case) + final `callModel` synthesis call (24s,
pre-existing) ≈ **61s** in the absolute worst case where everything times
out sequentially rather than failing fast. That's tighter than I'd like.
Options if this becomes a real problem in testing: drop the planner retry
attempt, reduce `SECOND_CHANCE_TIMEOUT_MS`, or raise `maxDuration` if
Vercel's plan allows it. Worth watching in testing rather than assuming
it's fine.

## Suggested next steps

1. Apply the diff (or copy the full file) into your local repo and diff
   against any changes you've made since the zip you sent.
2. Test with a real `OPENAI_API_KEY` set — specifically the planner retry
   and the second-chance pass, since those are the unverified pieces.
3. Re-run the same "Democratic Hold" scenario (or any other recent failing
   one) and compare `selected_count` / `scenario_matches` in the debug
   output before/after.
4. Watch actual response times in testing against the 60s budget above.
5. If this works well, the same `secondChanceEntityOverlap` pattern could
   probably help `hasScenarioContextOverlap`'s Tavily-side filtering too
   (in `fetchCustomTavilyArticles`) — not done here, deliberately scoped
   to the gate that was causing the reported symptom.
