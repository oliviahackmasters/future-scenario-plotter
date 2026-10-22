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
