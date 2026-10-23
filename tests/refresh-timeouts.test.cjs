const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

async function load(file, dependencies, globals = {}) {
  dependencies["node:crypto"] = { randomUUID: require("node:crypto").randomUUID };
  dependencies["../lib/scenario-evidence.js"] = await import("../lib/scenario-evidence.js");
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, process: { env: {
      OPENAI_API_KEY: 'test', BLOB_READ_WRITE_TOKEN: 'test', REDIS_URL: 'redis://test'
    } }, URL, AbortController,
    AbortSignal: { timeout: ms => AbortSignal.timeout(Math.max(1, ms / 100)) },
    setTimeout: (fn, ms) => setTimeout(fn, Math.max(1, ms / 100)), clearTimeout,
    ...globals
  });
  const mod = new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { context });
  await mod.link(name => {
    const values = dependencies[name];
    assert.ok(values, `Unexpected dependency: ${name}`);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await mod.evaluate();
  return mod.namespace;
}

function untilAborted(signal) {
  return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true }));
}

test('Redis failure uses built-in sources and a later invocation reconnects', async () => {
  let connections = 0;
  const mod = await load('lib/source-store.js', { redis: { createClient(options) {
    assert.equal(options.socket.reconnectStrategy, false);
    assert.equal(options.socket.connectTimeout, 3000);
    assert.equal(options.disableOfflineQueue, true);
    const client = new EventEmitter();
    client.connect = async () => { if (++connections === 1) throw new Error('unreachable'); };
    client.commandOptions = options => options;
    client.get = async () => null;
    return client;
  } } });
  assert.equal((await mod.getMergedSavedSources('iran')).length, 0);
  assert.equal((await mod.getMergedSavedSources('iran')).length, 0);
  assert.equal(connections, 2);
});

test('a connected Redis server that stops replying cannot stall saved sources', async () => {
  const mod = await load('lib/source-store.js', { redis: { createClient() {
    const client = new EventEmitter();
    client.connect = async () => {};
    client.commandOptions = options => options;
    client.get = options => untilAborted(options.signal);
    return client;
  } } });
  assert.equal((await mod.getMergedSavedSources('iran')).length, 0);
});

for (const extraFeedCount of [0, 35]) {
for (const stalled of [false, true]) {
  test(`refresh with ${extraFeedCount} extra feeds returns with stalled external APIs, storage and ${stalled ? 'stalled' : 'successful'} model`, async () => {
    let modelCalls = 0;
    const attemptedFeeds = new Set();
    const model = { summary: 'Evidence assessment', scenarios: ['Chaos + Collapse', 'Shattered Diplomacy', 'Burning Strait', 'Cold Containment'].map(name => ({ name, score: 25 })), signals: [], calculation: { scenarios: [] } };
    const mod = await load('api/scenario-assessment.js', {
      'rss-parser': { default: class { async parseString() { return { items: [{ title: 'Iran Gulf shipping update', link: 'https://test/article', contentSnippet: 'Iran oil flows and Hormuz shipping' }] }; } } },
      openai: { default: class {
        responses = { create: async (body, options) => {
          modelCalls++;
          assert.equal(options.maxRetries, 0);
          assert.equal(options.timeout, 22000);
          if (stalled) return untilAborted(options.signal);
          return { output_text: JSON.stringify(model) };
        } };
      } },
      '../lib/blob-store.js': {
        saveLatestAssessment: () => new Promise(() => {}),
        saveAssessmentHistory: () => new Promise(() => {})
      },
      '../lib/source-store.js': { getMergedSavedSources: () => extraFeedCount
        ? Promise.resolve(Array.from({ length: extraFeedCount }, (_, index) => ({ name: `Extra ${index}`, url: `https://test/feed-${index}`, type: 'rss' })))
        : new Promise(() => {}) }
    }, { fetch: (url, options) => {
      if (!options.headers.Accept.includes('application/rss')) return untilAborted(options.signal);
      attemptedFeeds.add(url);
      // An unavailable saved feed must not prevent the others from contributing.
      if (url.endsWith('/feed-0')) return untilAborted(options.signal);
      return Promise.resolve({ ok: true, text: async () => '<rss/>' });
    } });
    let status, payload;
    const res = { status(code) { status = code; return this; }, setHeader() { return this; }, send(body) { payload = JSON.parse(body); } };
    await mod.default({ method: 'GET', query: { topic: 'iran' } }, res);
    assert.equal(status, 200);
    assert.equal(payload.scenarios.length, 4);
    assert.equal(modelCalls, 1);
    assert.equal(payload.scenarios.reduce((sum, s) => sum + s.score, 0), 100);
    assert.equal(payload.history.length, 0);
    assert.equal(payload.score_type, 'relative_evidence_fit');
    assert.equal(payload.forecast_horizon, null);
    assert.equal(payload.signals.length, 14);
    assert.equal(payload.meta.source_coverage.length, 7 + extraFeedCount);
    assert.equal(attemptedFeeds.size, extraFeedCount ? 40 : 7);
    assert.equal(payload.meta.source_coverage.filter(source => source.status === 'error').length, extraFeedCount ? 1 : 0);
    assert.equal(payload.meta.source_coverage.filter(source => source.status === 'not_requested').length, extraFeedCount ? 2 : 0);
    assert.equal(payload.is_fallback, stalled);
    assert.equal(payload.summary.includes('timed out'), stalled);
  });
}

}

test('search RSS preserves real publication dates and leaves unknown dates unstamped', async () => {
  const mod = await load('api/tavily-rss.js', {
    '../lib/tavily-search.js': {
      buildScenarioSearchQuery: () => 'Iran',
      fetchTavilyArticles: async () => [
        { title: 'Undated Iran oil report', url: 'https://test.com/undated', snippet: 'Oil & shipping' },
        { title: 'Dated Iran oil report', url: 'https://test.com/dated', published_at: '2026-10-21', snippet: 'Iran oil' }
      ]
    }
  });
  let status, body;
  const res = { setHeader() { return this; }, status(value) { status = value; return this; }, send(value) { body = value; } };
  await mod.default({ method: 'GET', query: { topic: 'iran' } }, res);
  assert.equal(status, 200);
  assert.equal((body.match(/<pubDate>/g) || []).length, 1);
  assert.match(body, /<pubDate>2026-10-21<\/pubDate>/);
  assert.match(body, /Oil &amp; shipping/);
});

test('POST sources generates an ID without global crypto and persists to the selected topic', async () => {
  const saved = new Map();
  const existing = { id: 'existing-source', name: 'Existing', url: 'https://example.org/existing.xml' };
  saved.set('scenario:sources:iran', JSON.stringify([existing]));
  const store = await load('lib/source-store.js', {
    'node:crypto': { randomUUID: require('node:crypto').randomUUID },
    redis: { createClient() {
      const client = new EventEmitter();
      client.connect = async () => {};
      client.commandOptions = options => options;
      client.get = async (options, key) => saved.get(key) || null;
      client.set = async (options, key, value) => { saved.set(key, value); };
      return client;
    } }
  });
  const api = await load('api/sources.js', {
    '../lib/source-store.js': store,
    '../lib/source-catalog.js': { SOURCE_CATALOG: [] }
  });
  let status, payload;
  const res = { status(code) { status = code; return this; }, setHeader() { return this; }, send(body) { payload = JSON.parse(body); } };
  await api.default({ method: 'POST', query: { topic: 'iran' }, headers: {}, body: { name: 'New RSS', url: 'https://example.org/new.xml' } }, res);
  assert.equal(status, 200, JSON.stringify(payload));
  assert.equal(payload.ok, true);
  const persisted = JSON.parse(saved.get('scenario:sources:iran'));
  assert.equal(persisted.length, 2);
  assert.equal(persisted[0].id, existing.id);
  assert.match(persisted[1].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(saved.has('scenario:sources:global'), false);
  const reloaded = await store.getSavedSources('iran');
  assert.equal(reloaded.topic[1].url, 'https://example.org/new.xml');
});
