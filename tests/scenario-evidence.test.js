import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyOilSignal, completeSignals, relativeScores } from '../lib/scenario-evidence.js';

test('monthly Brent observations include dates, units and a non-live label', () => {
  const oil = monthlyOilSignal({ data: [ { date: '2026-09-01', value: '114.16' }, { date: '2026-08-01', value: '91.08' } ] }, new Date('2026-10-22'));
  assert.equal(oil.status, 'ok');
  assert.equal(oil.observation_date, '2026-09-01');
  assert.match(oil.signal.reading, /monthly average for 2026-09: 114.16 USD\/bbl/);
  assert.match(oil.signal.reading, /2026-08: 91.08/);
  assert.match(oil.signal.reading, /not a live price/);
  assert.equal(oil.signal.sources.length, 1);
});

test('invalid and old oil observations cannot be treated as current', () => {
  assert.equal(monthlyOilSignal({ data: [{ date: '2026-09-01', value: '.' }] }).status, 'unavailable');
  const old = monthlyOilSignal({ data: [{ date: '2025-01-01', value: '114.16' }] }, new Date('2026-10-22'));
  assert.equal(old.status, 'stale');
  assert.equal(old.signal.evidence_status, 'insufficient');
  assert.equal(old.signal.direction, 'neutral');
});

test('omitted signals and invented citations become explicitly unknown', () => {
  const signals = completeSignals({ trackedSignals: ['stability', 'flows', 'deployment'] }, [
    { name: 'flows', sources: [{ url: 'https://real' }], reading: 'Exports continue.', confidence: 'Medium' },
    { name: 'deployment', sources: [{ url: 'https://invented' }], reading: 'Stable', confidence: 'High' }
  ], [{ url: 'https://real' }], []);
  assert.equal(signals.length, 3);
  assert.equal(signals[0].evidence_status, 'insufficient');
  assert.match(signals[0].reading, /Unknown/);
  assert.equal(signals[1].evidence_status, 'supported');
  assert.equal(signals[2].confidence, 'Low');
  assert.equal(signals[2].sources.length, 0);
});

test('fractional and percentage model scores have the same scale before market boosts', () => {
  assert.deepEqual(relativeScores([{ name: 'a', score: .2 }, { name: 'b', score: .8 }], ['a', 'b']), [20, 80]);
  assert.deepEqual(relativeScores([{ name: 'a', score: 20 }, { name: 'b', score: 80 }], ['a', 'b']), [20, 80]);
});

test('current news survives a large saved-source pack; landing pages and old articles do not', async () => {
  const { selectEvidenceArticles } = await import('../lib/scenario-evidence.js');
  const config = { keywordFilter: ['iran', 'hormuz', 'oil', 'gulf'] };
  const items = [
    { source: 'Reuters Web Search', title: 'Iran War: Latest Breaking News', url: 'https://reuters.com/world/iran', contentSnippet: 'Iran oil Gulf Hormuz' },
    { source: 'World News API', title: 'Iran News API', url: 'https://worldnewsapi.com/docs/iran-news-api', contentSnippet: 'Iran oil Gulf Hormuz' },
    { source: 'X', title: 'Iran oil Gulf', url: 'https://x.com/IRIMFA_EN', contentSnippet: 'Iran oil Gulf Hormuz' },
    { source: 'Old research', title: 'Iran Gulf Hormuz oil conflict', url: 'https://research.org/2025/04/17/report', contentSnippet: 'Iran oil Gulf Hormuz' },
    ...Array.from({ length: 12 }, (_, i) => ({ source: `Saved ${i}`, title: 'Iran oil Gulf analysis', url: `https://saved${i}.org/articles/analysis`, contentSnippet: 'Iran oil Gulf Hormuz analysis' })),
    { source: 'BBC', title: 'Iran Hormuz oil disruption', url: 'https://bbc.com/news/articles/report', isoDate: '2026-10-22', contentSnippet: 'Iran Gulf oil flows disrupted near Hormuz' },
    { source: 'FT', title: 'Iran Gulf oil flows recover', url: 'https://ft.com/content/report', isoDate: '2026-10-21', contentSnippet: 'Iran oil shipments via alternative routes in Gulf' }
  ];
  const selected = selectEvidenceArticles(items, config, 12, new Date('2026-10-22T12:00:00Z'));
  assert.deepEqual(selected.slice(0, 2).map(item => item.source), ['BBC', 'FT']);
  assert.ok(!selected.some(item => ['Reuters Web Search', 'World News API', 'X', 'Old research'].includes(item.source)));
  assert.equal(selectEvidenceArticles([{ source: 'Saved', title: 'Sports results', url: 'https://test.com/sports/report', contentSnippet: 'football scores' }], config).length, 0);
});

test('publisher cap applies across feeds hosted on the same domain', async () => {
  const { selectEvidenceArticles } = await import('../lib/scenario-evidence.js');
  const items = Array.from({ length: 6 }, (_, i) => ({ title: 'Iran oil Gulf', source: `FT ${i}`, url: `https://ft.com/content/${i}`, isoDate: '2026-10-22' }));
  assert.equal(selectEvidenceArticles(items, { keywordFilter: ['iran', 'oil', 'gulf'] }, 12, new Date('2026-10-22')).length, 3);
});
