const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

async function load(file, dependencies, globals = {}) {
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

for (const stalled of [false, true]) {
  test(`refresh returns with stalled feeds, storage and ${stalled ? 'stalled' : 'successful'} model`, async () => {
    let modelCalls = 0;
    const model = { summary: 'Evidence assessment', scenarios: [], signals: [], calculation: { scenarios: [] } };
    const mod = await load('api/scenario-assessment.js', {
      'rss-parser': { default: class {} },
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
      '../lib/source-store.js': { getMergedSavedSources: () => new Promise(() => {}) }
    }, { fetch: (url, options) => untilAborted(options.signal) });
    let status, payload;
    const res = { status(code) { status = code; return this; }, setHeader() { return this; }, send(body) { payload = JSON.parse(body); } };
    await mod.default({ method: 'GET', query: { topic: 'iran' } }, res);
    assert.equal(status, 200);
    assert.equal(payload.scenarios.length, 4);
    assert.equal(modelCalls, 1);
    assert.equal(payload.scenarios.reduce((sum, s) => sum + s.score, 0), 100);
    assert.equal(payload.history.length, 0);
    assert.equal(payload.summary.includes('timed out'), stalled);
  });
}
