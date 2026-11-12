'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { harness, loadFiles, plain } = require('./helpers.js');

function graphApi() {
  const context = vm.createContext({});
  loadFiles(context, ['graphs.js']);
  return vm.runInContext(`({ TelemetryGraphIndex, diagnosticGraphRange, buildDiagnosticGraph,
    diagnosticGraphLayout, renderDiagnosticCanvas, hitDiagnosticMeasurement, specs: DIAGNOSTIC_GRAPH_SPECS })`, context);
}

const units = { 0x14: 'V', 0x15: 'V', 0x06: '%', 0x07: '%', 0x0C: 'rpm', 0x04: '%', 0x11: '%', 0x05: '°C' };
function sample(pid, elapsedMs, value, quality = 'valid', extra = {}) {
  const timestamp = new Date(Date.parse('2026-11-12T15:00:00Z') + elapsedMs).toISOString();
  return { mode: '01', pid, pidHex: pid.toString(16).toUpperCase().padStart(2, '0'),
    label: 'Recorded PID ' + pid, unit: units[pid], elapsedMs, timestamp, requestedAt: timestamp,
    responseMs: 100, value, quality, reason: null, locationVerified: pid === 0x14 || pid === 0x15, ...extra };
}
function session(samples = [], extra = {}) {
  return { id: 'fixture', source: 'demo', endedAt: '2026-11-12T15:01:00Z', samples,
    metadata: { supportedPids: Object.keys(units).map(Number), measurements: Object.keys(units).map(pid =>
      ({ pid: Number(pid), locationVerified: Number(pid) === 0x14 || Number(pid) === 0x15 })) }, ...extra };
}
function modelFor(api, recording, id = 'oxygen', durationMs = 60000, range = null) {
  const index = new api.TelemetryGraphIndex(); index.update(recording);
  return api.buildDiagnosticGraph(index, api.specs.find(spec => spec.id === id),
    range || api.diagnosticGraphRange(durationMs), durationMs);
}
function canvasSpy() {
  const calls = [];
  const ctx = {};
  for (const method of ['setTransform', 'fillRect', 'fillText', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'arc', 'rect', 'fill']) {
    ctx[method] = (...args) => calls.push([method, ...args]);
  }
  return { calls, width: 0, height: 0, getContext: () => ctx };
}

test('irregular oxygen readings share the same real-time transform and retain original measurements', () => {
  const api = graphApi();
  const recording = session([sample(0x14, 0, 0.1), sample(0x15, 2000, 0.6),
    sample(0x14, 10000, 0.8), sample(0x15, 55000, 0.65)]);
  const original = JSON.stringify(recording);
  const model = modelFor(api, recording);
  const layout = api.diagnosticGraphLayout(900, 280, model);
  assert.equal((layout.x(55000) - layout.x(10000)) / (layout.x(10000) - layout.x(0)), 4.5);
  assert.equal(layout.x(model.series[1].entries[0].sample.elapsedMs), layout.x(2000));
  assert.equal(model.series[0].entries[1].sample, recording.samples[2]);
  assert.equal(JSON.stringify(recording), original);
  assert.equal(model.entries.length, 4); // No fabricated values at the other sensor's timestamps.
});

test('missing, failed, nonnumeric and wrong-unit results never turn into zero-valued measurements', () => {
  const api = graphApi();
  const recording = session([sample(0x14, 1000, 0), sample(0x14, 2000, null, 'missing', { reason: 'NO DATA' }),
    sample(0x14, 3000, null, 'failed', { reason: 'Truncated payload' }),
    sample(0x14, 4000, NaN), sample(0x14, 5000, 0.5, 'valid', { unit: 'mV' })]);
  const model = modelFor(api, recording);
  assert.equal(model.series[0].valid, 1);
  assert.equal(model.series[0].missing, 1);
  assert.equal(model.series[0].failed, 3);
  assert.equal(recording.samples[4].quality, 'valid'); // Presentation never rewrites stored quality.
  const canvas = canvasSpy();
  const layout = api.renderDiagnosticCanvas(canvas, model);
  const arcs = canvas.calls.filter(call => call[0] === 'arc');
  assert.equal(arcs.length, 2); // One valid zero and one missing-result marker; failures are crosses.
  assert.equal(arcs[0][2], layout.y(0));
  assert.equal(arcs[1][2], layout.qualityY(0));
  assert.ok(layout.qualityY(0) > layout.top + layout.plotHeight);
});

test('valid values outside dashboard display bounds expand axes without clipping', () => {
  const api = graphApi();
  const trim = modelFor(api, session([sample(6, 1000, -100), sample(7, 2000, 99.21875)]), 'trims');
  assert.ok(trim.yAxis.min <= -100 && trim.yAxis.max >= 99.21875);
  const rpm = modelFor(api, session([sample(12, 1000, 10000)]), 'rpm');
  assert.ok(rpm.yAxis.max >= 10000);
  const coolant = modelFor(api, session([sample(5, 1000, -40), sample(5, 2000, 150)]), 'coolant');
  assert.ok(coolant.yAxis.min <= -40 && coolant.yAxis.max >= 150);
});

test('empty, zero-duration, and single-point recordings have finite scales and visible markers', () => {
  const api = graphApi();
  for (const results of [[], [sample(0x14, 0, 0.5)], [sample(0x14, 25, 0.5)]]) {
    const model = modelFor(api, session(results), 'oxygen', results.length ? 25 : 0);
    const canvas = canvasSpy(); const layout = api.renderDiagnosticCanvas(canvas, model, { width: 270 });
    assert.ok(Number.isFinite(layout.x(0)) && Number.isFinite(layout.y(0.5)));
    assert.equal(model.entries.length, results.length);
    assert.equal(canvas.calls.filter(call => call[0] === 'arc').length, results.length);
    if (!results.length) assert.ok(canvas.calls.some(call => call[0] === 'fillText' && /No valid/.test(call[1])));
  }
});

test('rolling and custom time ranges include actual boundary readings and reject bad inputs', () => {
  const api = graphApi();
  assert.deepEqual(plain(api.diagnosticGraphRange(90000, '30')), { startMs: 60000, endMs: 90000 });
  assert.deepEqual(plain(api.diagnosticGraphRange(90000, 'custom', 1.25, 13.75)), { startMs: 1250, endMs: 13750 });
  for (const pair of [[-1, 10], [10, 10], [20, 10], [0, 100], [NaN, 10], [0, Infinity]]) {
    assert.ok(api.diagnosticGraphRange(90000, 'custom', ...pair).error);
  }
  assert.ok(api.diagnosticGraphRange(1000, 'custom', 1.0001, 1.0003).error);
  const model = modelFor(api, session([sample(20, 59999, 0.1), sample(20, 60000, 0.2),
    sample(21, 90000, 0.6), sample(21, 90001, 0.7)]), 'oxygen', 90000, api.diagnosticGraphRange(90000, '30'));
  assert.deepEqual(plain(model.entries.map(entry => entry.sample.elapsedMs)), [60000, 90000]);
});

test('unavailable data distinguishes unsupported PIDs, unsampled PIDs and an empty selected range', () => {
  const api = graphApi();
  const recording = session([sample(20, 1000, 0.5)]);
  recording.metadata.supportedPids = [20];
  const model = modelFor(api, recording, 'oxygen', 60000, { startMs: 30000, endMs: 60000 });
  assert.match(model.series[0].availability, /No results in this time range/);
  assert.match(model.series[1].availability, /Not advertised/);
  recording.metadata.supportedPids.push(21);
  assert.match(modelFor(api, recording).series[1].availability, /no recorded results yet/);
  recording.metadata = {};
  assert.match(modelFor(api, recording).series[1].availability, /support information unavailable/);
});

test('Bank 1 upstream/downstream names require verified recording metadata and readings', () => {
  const api = graphApi();
  const recording = session([sample(20, 1000, 0.5), sample(21, 2000, 0.6)]);
  assert.match(modelFor(api, recording).series[0].label, /B1S1.*upstream/);
  recording.samples[1].locationVerified = false;
  assert.match(modelFor(api, recording).series[1].label, /location unverified/);
  recording.metadata.measurements = [];
  assert.match(modelFor(api, recording).series[0].label, /location unverified/);
});

test('window sampling rates use valid intervals and sample age uses the whole recording', () => {
  const api = graphApi();
  const recording = session([sample(20, 0, 0.1), sample(20, 1000, 0.2),
    sample(20, 2000, null, 'missing'), sample(20, 5000, 0.8)]);
  const model = modelFor(api, recording, 'oxygen', 10000);
  assert.equal(model.series[0].rateHz, 0.4);
  assert.equal(model.series[0].ageMs, 5000);
  const short = modelFor(api, recording, 'oxygen', 10000, { startMs: 4000, endMs: 6000 });
  assert.equal(short.series[0].rateHz, null);
  assert.equal(short.series[0].ageMs, 5000);
});

test('index updates incrementally, sorts unexpected out-of-order timestamps and clears across sessions', () => {
  const api = graphApi(); const index = new api.TelemetryGraphIndex();
  const recording = session([sample(20, 5000, 0.1)]); index.update(recording);
  recording.samples.push(sample(20, 1000, 0.5)); index.update(recording); index.update(recording);
  assert.equal(index.cursor, 2);
  assert.deepEqual(plain(index.byPid.get(20).map(entry => entry.sample.elapsedMs)), [1000, 5000]);
  index.update(session([sample(20, 2000, 0.9)]));
  assert.equal(index.byPid.get(20).length, 1);
  assert.equal(index.byPid.get(20)[0].sample.value, 0.9);
  index.update(null); assert.equal(index.byPid.size, 0);
});

test('invalid timestamps are counted as unplottable rather than assigned fabricated times', () => {
  const api = graphApi();
  const invalid = sample(20, 1000, 0.5); invalid.elapsedMs = NaN;
  const model = modelFor(api, session([invalid]));
  assert.equal(model.entries.length, 0);
  assert.equal(model.series[0].invalidTimes, 1);
});

test('hit inspection returns original valid or missing samples at desktop and mobile widths', () => {
  const api = graphApi();
  const recording = session([sample(20, 10000, 0.5), sample(21, 20000, null, 'missing')]);
  const model = modelFor(api, recording);
  for (const width of [270, 1000]) {
    const layout = api.diagnosticGraphLayout(width, 280, model);
    assert.equal(api.hitDiagnosticMeasurement(model, layout, layout.x(10000), layout.y(0.5)).sample, recording.samples[0]);
    assert.equal(api.hitDiagnosticMeasurement(model, layout, layout.x(20000), layout.qualityY(1)).sample, recording.samples[1]);
    assert.equal(api.hitDiagnosticMeasurement(model, layout, -100, -100), null);
  }
});

test('Canvas rendering retains every result, batches marks, respects pixel ratio, and stamps demo data', t => {
  const api = graphApi();
  const results = Array.from({ length: 20000 }, (_, i) => sample(i % 2 ? 21 : 20, i * 150, (i % 250) / 200,
    i % 31 === 0 ? 'missing' : i % 47 === 0 ? 'failed' : 'valid'));
  const recording = session(results);
  const start = performance.now();
  const model = modelFor(api, recording, 'oxygen', 3000000);
  const canvas = canvasSpy();
  api.renderDiagnosticCanvas(canvas, model, { width: 1000, pixelRatio: 2 });
  t.diagnostic('20,000-result model and instrumented render: ' + (performance.now() - start).toFixed(1) + ' ms');
  assert.equal(model.entries.length, 20000);
  assert.equal(canvas.width, 2000); assert.equal(canvas.height, 560);
  assert.equal(canvas.calls.filter(call => call[0] === 'fill').length, 2); // Batched per series.
  assert.ok(canvas.calls.some(call => call[0] === 'fillText' && call[1] === 'SIMULATED DATA'));
  assert.equal(recording.samples.length, 20000);
  assert.equal(model.entries[19999].sample, results[19999]);
});

test('narrow sub-second custom ranges keep distinct elapsed-time tick labels', () => {
  const api = graphApi(); const canvas = canvasSpy();
  const model = modelFor(api, session([sample(20, 1010, 0.5)]), 'oxygen', 2000,
    api.diagnosticGraphRange(2000, 'custom', 1, 1.02));
  api.renderDiagnosticCanvas(canvas, model, { width: 270 });
  const labels = canvas.calls.filter(call => call[0] === 'fillText' && call[3] === 248).map(call => call[1]);
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(labels.length >= 3);
});

test('UI measurement inspection includes exact times, stored quality, reasons and request duration', async t => {
  const h = harness(); t.after(() => h.close());
  h.context.fixture = session([sample(20, 1000, 0.55), sample(21, 1500, null, 'missing', { reason: 'NO DATA' })]);
  h.run('diagnosticGraphs.update(fixture, {durationMs: 60000})');
  await h.click('next-oxygen');
  assert.match(h.node('inspect-oxygen').textContent, /1000.000 ms elapsed/);
  assert.match(h.node('inspect-oxygen').textContent, /0.55 V.*recorded quality: valid/);
  await h.click('next-oxygen');
  assert.match(h.node('inspect-oxygen').textContent, /no value.*missing \(NO DATA\)/);
  assert.match(h.node('inspect-oxygen').textContent, /including queue wait: 100.000 ms/);
  assert.equal(h.node('next-oxygen').disabled, true);
  await h.node('graph-oxygen').dispatch('keydown', { key: 'Home' });
  assert.match(h.node('inspect-oxygen').textContent, /1 \/ 2/);
  await h.node('graph-oxygen').dispatch('keydown', { key: 'ArrowRight' });
  assert.match(h.node('inspect-oxygen').textContent, /2 \/ 2/);
});

test('UI custom-range errors preserve the previous valid shared window', async t => {
  const h = harness(); t.after(() => h.close());
  h.context.fixture = session([sample(20, 1000, 0.5), sample(6, 2000, 5), sample(12, 3000, 850)]);
  h.run('diagnosticGraphs.update(fixture, {durationMs: 60000})');
  h.node('graphRange').value = 'custom';
  await h.node('graphRange').dispatch('change');
  h.node('graphFrom').value = '1.5'; h.node('graphTo').value = '4';
  await h.click('graphApplyRange');
  assert.ok(h.run('diagnosticGraphs.views.every(view => view.model.range.startMs === 1500 && view.model.range.endMs === 4000)'));
  h.node('graphFrom').value = '';
  await h.click('graphApplyRange');
  assert.match(h.node('graphRangeError').textContent, /Enter a start/);
  assert.equal(h.run('diagnosticGraphs.range.startMs'), 1500);
});

test('clock refreshes do not apply unfinished custom-range edits', async t => {
  const h = harness(); t.after(() => h.close());
  h.context.fixture = session([sample(20, 1000, 0.5)]);
  h.run('diagnosticGraphs.update(fixture, {durationMs: 60000})');
  h.node('graphRange').value = 'custom'; await h.node('graphRange').dispatch('change');
  h.node('graphFrom').value = '20'; h.node('graphTo').value = '30';
  h.run('diagnosticGraphs.update(fixture, {durationMs: 61000})');
  assert.equal(h.run('diagnosticGraphs.range.startMs'), 0);
  assert.equal(h.run('diagnosticGraphs.range.endMs'), 60000);
  await h.click('graphApplyRange');
  assert.equal(h.run('diagnosticGraphs.range.startMs'), 20000);
  assert.equal(h.run('diagnosticGraphs.range.endMs'), 30000);
});

test('UI click inspection converts CSS coordinates to graph coordinates without selecting inferred values', async t => {
  const h = harness(); t.after(() => h.close());
  h.context.fixture = session([sample(20, 10000, 0.5), sample(21, 20000, 0.7)]);
  h.node('graph-oxygen').getBoundingClientRect = () => ({ width: 270, height: 280, left: 30, top: 40 });
  h.run('diagnosticGraphs.update(fixture, {durationMs: 60000})');
  const point = h.run(`({ x: diagnosticGraphs.views[0].layout.x(20000), y: diagnosticGraphs.views[0].layout.y(0.7) })`);
  await h.node('graph-oxygen').dispatch('click', { clientX: point.x + 30, clientY: point.y + 40 });
  assert.match(h.node('inspect-oxygen').textContent, /B1S2.*0.7 V/);
  await h.node('graph-oxygen').dispatch('click', { clientX: 30, clientY: 40 });
  assert.match(h.node('inspect-oxygen').textContent, /No recorded measurement near/);
  assert.equal(h.run('diagnosticGraphs.views[0].selectedOrder'), null);
});

test('unchanged stopped recordings skip redraws and replacement sessions clear inspection and data', async t => {
  const h = harness(); t.after(() => h.close());
  h.context.fixture = session([sample(20, 1000, 0.5)]);
  h.run(`diagnosticGraphs.update(fixture, {durationMs: 60000});
    var originalModel = diagnosticGraphs.views[0].model;`);
  await h.click('next-oxygen');
  h.run('diagnosticGraphs.update(fixture, {durationMs: 60000})');
  assert.equal(h.run('diagnosticGraphs.views[0].model === originalModel'), true);
  h.context.fixture = session([]); // Same fixture ID intentionally tests identity, too.
  h.run('diagnosticGraphs.update(fixture, {durationMs: 60000})');
  assert.equal(h.run('diagnosticGraphs.views[0].model.entries.length'), 0);
  assert.equal(h.run('diagnosticGraphs.views[0].selectedOrder'), null);
  assert.match(h.node('inspect-oxygen').textContent, /No recorded results/);
});
