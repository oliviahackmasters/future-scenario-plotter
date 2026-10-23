const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
  const elements = new Map();
  function element() {
    return { innerHTML: '', textContent: '', style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelector() { return element(); } };
  }
  const names = ['Chaos + Collapse', 'Shattered Diplomacy', 'Burning Strait', 'Cold Containment'];
  const cells = names.map(name => { const node = element(); node.getAttribute = () => name; node.title = element(); node.querySelector = () => node.title; return node; });
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    querySelector() { return element(); },
    querySelectorAll(selector) { return selector.includes('.hm-plot-cell') ? cells : []; }
  };
  const context = vm.createContext({ document, window: {}, console });
  const html = fs.readFileSync('squarespaceembed.html', 'utf8');
  for (const [, script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    vm.runInContext(script.replace('hmInit();', ''), context);
  }
  const colors = vm.runInContext('HM_SCENARIO_COLORS', context);
  return { elements, cells, context, names, colors };
}

test('source list shows attempted feeds, including zero results, without listing unused catalogue entries', () => {
  const { elements, context } = setup();
  context.render({ scenarios: [], history: [], signals: [], sources: [], updated_at: new Date().toISOString(), meta: {
    source_coverage: [
      { name: 'WHO', url: 'https://test/who', status: 'ok', items_returned: 4, articles_used: 0 },
      { name: 'Zero results', url: 'https://test/zero', status: 'ok', items_returned: 0, articles_used: 0 },
      { name: 'Unavailable', url: 'https://test/error', status: 'error' },
      { name: 'Unsearched', url: 'https://test/skipped', status: 'not_requested' },
      { name: 'Disabled', url: 'https://test/disabled', status: 'ok' }
    ],
    saved_sources: [ { id: 'who-id', name: 'WHO', url: 'https://test/who' }, { id: 'disabled', url: 'https://test/disabled', enabled: false } ]
  } });
  const list = elements.get('hmSavedSources').innerHTML;
  assert.match(list, /WHO/);
  assert.match(list, /4 results · 0 articles used/);
  assert.match(list, /Zero results/);
  assert.match(list, /Search attempted · unavailable/);
  assert.doesNotMatch(list, /Unsearched|Disabled|confidence/);
  assert.match(list, /hmDeleteSource\('who-id'\)/);
  assert.equal((list.match(/hm-source-row/g) || []).length, 3);
});

test('outcome cards and plot quadrants use the timeline colour mapping', () => {
  const { elements, context, cells, names, colors } = setup();
  context.render({ scenarios: names.map(name => ({ name, score: 25, description: 'Evidence' })), history: [], signals: [], sources: [], updated_at: new Date().toISOString(), meta: {} });
  const cards = elements.get('hmScenarioGrid').innerHTML;
  for (let index = 0; index < names.length; index++) {
    const color = colors[names[index]];
    assert.ok(cards.includes(`background:${color};`));
    assert.ok(cards.includes(`border-color:${color};`));
    assert.equal(cells[index].title.style.color, color);
    assert.equal(cells[index].style.borderLeft, `3px solid ${color}`);
  }
});
