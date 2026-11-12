'use strict';

// Run offline with: node --test tests/recording.test.js
// All adapters below are simulated. No Bluetooth chooser or mode 04 is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const { harness, recorderFixture, plain, waitFor } = require('./helpers.js');

test('records wall time, monotonic elapsed time, queue submission time, native units and notes', () => {
  const f = recorderFixture();
  f.start({ notes: 'Warm idle', metadata: { protocol: 'test', supportedPids: [6] } });
  f.advance(125);
  const request = f.recorder.captureRequest(1);
  f.advance(800);
  f.recorder.record(request, { pid: 6, label: 'Short fuel trim B1', unit: '%', quality: 'valid', value: 31.25 });
  const sample = f.recorder.session.samples[0];
  assert.equal(sample.requestedAt, '2026-11-12T15:00:00.125Z');
  assert.equal(sample.timestamp, '2026-11-12T15:00:00.925Z');
  assert.equal(sample.requestElapsedMs, 125);
  assert.equal(sample.elapsedMs, 925);
  assert.equal(sample.responseMs, 800);
  assert.equal(sample.pidHex, '06');
  assert.equal(sample.value, 31.25); // Must not clip to the dashboard's +/-25% range.
  assert.equal(sample.unit, '%');
  assert.equal(f.recorder.session.notes, 'Warm idle');
});

test('wall-clock corrections do not change elapsed time or response duration', () => {
  const f = recorderFixture(); f.start();
  const request = f.recorder.captureRequest(1);
  f.time.wallMs -= 60000; f.time.monoMs += 300;
  f.recorder.record(request, { pid: 6, label: 'Trim', quality: 'valid', value: 0 });
  assert.equal(f.recorder.session.samples[0].elapsedMs, 300);
  assert.equal(f.recorder.session.samples[0].responseMs, 300);
});

test('missing and failed readings have null values and separate quality counters', () => {
  const f = recorderFixture(); f.start();
  f.record(0); f.advance(100);
  f.record(999, 'missing', { reason: 'No matching payload' });
  f.record(999, 'failed', { reason: 'GATT write failed' });
  assert.deepEqual(plain(f.recorder.session.counts), { valid: 1, missing: 1, failed: 1 });
  assert.deepEqual(plain(f.recorder.session.samples.map(s => s.value)), [0, null, null]);
  assert.equal(f.recorder.session.samples[2].reason, 'GATT write failed');
});

test('recorder rejects nonfinite decoded values even if a caller marks them valid', () => {
  const f = recorderFixture(); f.start();
  f.record(NaN); f.record(Infinity); f.record(undefined);
  assert.equal(f.recorder.session.counts.failed, 3);
  assert.ok(f.recorder.session.samples.every(s => s.value === null));
});

test('achieved rate uses irregular valid timestamps, not missing samples or configured rates', () => {
  const f = recorderFixture(); f.start(); f.record(1);
  assert.equal(f.recorder.summary().series[0].rateHz, null);
  f.advance(1500); f.record(2);
  f.advance(500); f.record(null, 'missing');
  f.advance(2000); f.record(3);
  f.advance(1000);
  const stats = f.recorder.summary().series[0];
  assert.equal(stats.rateHz, 0.5);
  assert.equal(stats.ageMs, 1000);
  assert.equal(stats.minIntervalMs, 1500);
  assert.equal(stats.maxIntervalMs, 2500);
});

test('recording identities reject reads begun before start or during a previous recording', () => {
  const f = recorderFixture();
  const beforeStart = f.recorder.captureRequest(1);
  f.start();
  const oldRequest = f.recorder.captureRequest(1);
  f.recorder.stop(); f.start();
  const reading = { pid: 6, label: 'Trim', quality: 'valid', value: 3 };
  assert.equal(f.recorder.record(beforeStart, reading), false);
  assert.equal(f.recorder.record(oldRequest, reading), false);
  assert.equal(f.recorder.session.samples.length, 0);
  assert.equal(f.record(4), true);
});

test('connection identities reject stale replies and capture the disconnect boundary', () => {
  const f = recorderFixture(); f.start();
  const request = f.recorder.captureRequest(1);
  assert.equal(f.recorder.captureRequest(2), null);
  assert.equal(f.recorder.endConnection(2), false);
  f.advance(200); f.recorder.endConnection(1);
  assert.equal(f.recorder.active, false);
  assert.equal(f.recorder.session.stopReason, 'disconnected');
  assert.deepEqual(plain(f.recorder.session.events.map(e => e.type)),
    ['recording-start', 'connection-end', 'recording-stop']);
  f.start({ connectionId: 2, source: 'demo' });
  assert.equal(f.recorder.record(request, { pid: 6, label: 'Trim', quality: 'valid', value: 2 }), false);
  assert.equal(f.recorder.session.source, 'demo');
});

test('sample limit stops explicitly without evicting collected measurements', () => {
  const f = recorderFixture({ maxSamples: 3 }); f.start();
  for (let i = 0; i < 1000; i++) f.record(i);
  assert.deepEqual(plain(f.recorder.session.samples.map(s => s.value)), [0, 1, 2]);
  assert.equal(f.recorder.session.stopReason, 'sample-limit');
  assert.equal(f.recorder.session.events.length, 2);
});

test('production-size recording remains bounded at 20,000 results under sustained input', () => {
  const f = recorderFixture(); f.start();
  for (let i = 0; i < 25000; i++) { f.advance(10); f.record(i % 100); }
  assert.equal(f.recorder.session.samples.length, 20000);
  assert.equal(f.recorder.session.samples[0].value, 0);
  assert.equal(f.recorder.session.samples[19999].value, 99);
  assert.equal(f.recorder.summary().valid, 20000);
  assert.equal(Object.keys(f.recorder.session.byPid).length, 1);
  assert.equal(f.recorder.session.events.length, 2);
  assert.equal(f.recorder.session.stopReason, 'sample-limit');
});

test('duration limit stops idle recordings and excludes replies after the limit', () => {
  const f = recorderFixture({ maxDurationMs: 1000 }); f.start();
  const request = f.recorder.captureRequest(1);
  f.advance(1000);
  assert.equal(f.recorder.record(request, { pid: 6, label: 'Trim', quality: 'valid', value: 2 }), false);
  assert.equal(f.recorder.session.stopReason, 'duration-limit');
  assert.equal(f.recorder.session.samples.length, 0);
  f.start(); f.advance(1000); f.recorder.enforceLimit();
  assert.equal(f.recorder.active, false);
});

test('metadata is snapshotted, notes are bounded, and duration freezes after stop', () => {
  const f = recorderFixture(); const metadata = { supportedPids: [6] };
  f.start({ metadata }); metadata.supportedPids.push(7);
  assert.deepEqual(plain(f.recorder.session.metadata.supportedPids), [6]);
  f.recorder.setNotes('x'.repeat(5000));
  assert.equal(f.recorder.session.notes.length, 4000);
  f.advance(200); f.recorder.stop(); f.advance(1000);
  assert.equal(f.recorder.summary().durationMs, 200);
  assert.equal(f.recorder.stop(), false);
});

test('recording cannot silently replace an active session or omit its data source', () => {
  const f = recorderFixture();
  assert.throws(() => f.recorder.start({ connectionId: 1 }), /explicit data source/);
  f.start(); assert.throws(() => f.start(), /Stop the current/);
});

test('PID validation handles encoding lengths, byte integrity, and known scaling', t => {
  const h = harness(); t.after(() => h.close());
  assert.equal(h.run('decodePidReading(0x0C, [0x0F, 0xA0]).value'), 1000);
  assert.equal(h.run('decodePidReading(0x14, [255, 255]).value'), 1.275);
  assert.equal(h.run('decodePidReading(0x06, [0]).value'), -100);
  assert.equal(h.run('decodePidReading(0x06, [255]).value'), 99.21875);
  for (const expression of ['[]', '[15]', '[15, undefined]', '[15, 256]', '[15, -1]', '[15, 1.5]']) {
    assert.equal(h.run(`decodePidReading(0x0C, ${expression}).quality`), 'failed', expression);
  }
  assert.equal(h.run('decodePidReading(0x14, [100]).quality'), 'failed');
  assert.equal(h.run('decodePidReading(0x06, null).quality'), 'missing');
  assert.equal(h.run('decodePidReading(0x24, [0, 0, 0, 0]).quality'), 'failed');
  h.run('PIDS[0x06].decode = () => Infinity');
  assert.equal(h.run('decodePidReading(0x06, [128]).quality'), 'failed');
});

test('operator controls record notes, require replacement confirmation and label demo data', async t => {
  const h = harness(); t.after(() => h.close());
  h.attach(async () => [128], { source: 'demo' });
  h.node('recordingNotes').value = 'Warm idle';
  await h.click('btnRecordStart');
  await h.run('samplePid(0x06)');
  h.tick();
  assert.match(h.node('recordingSource').textContent, /SIMULATED DATA/);
  assert.equal(h.run('recorder.session.notes'), 'Warm idle');
  h.node('recordingNotes').value = 'Steady idle'; await h.node('recordingNotes').dispatch('input');
  assert.equal(h.run('recorder.session.notes'), 'Steady idle');
  await h.click('btnRecordStop');
  assert.equal(h.run('state.running'), true); // Stopping recording must not stop acquisition.
  h.context.window.confirm = () => false;
  await h.click('btnRecordStart');
  assert.equal(h.run('recorder.session.samples.length'), 1);
  h.context.window.confirm = () => true;
  await h.click('btnRecordStart');
  assert.equal(h.run('recorder.session.samples.length'), 0);
  assert.equal(h.run('recorder.session.notes'), '');
});

test('starting recording while a read is in flight excludes that read, without losing dashboard updates', async t => {
  const h = harness(); t.after(() => h.close());
  let resolve;
  h.attach(() => new Promise(r => { resolve = r; }));
  const pending = h.run('samplePid(0x06)');
  await h.click('btnRecordStart');
  resolve([140]); await pending;
  assert.equal(h.run('recorder.session.samples.length'), 0);
  assert.equal(h.run('state.last.get(0x06)'), 9.375);
});

test('stop/start on the same connection cannot accept the previous recording\'s pending result', async t => {
  const h = harness(); t.after(() => h.close());
  let resolve;
  h.attach(() => new Promise(r => { resolve = r; }));
  await h.click('btnRecordStart');
  const pending = h.run('samplePid(0x06)');
  await h.click('btnRecordStop'); await h.click('btnRecordStart');
  resolve([128]); await pending;
  assert.equal(h.run('recorder.session.samples.length'), 0);
});

for (const rejection of [false, true]) {
  test(`old connection's delayed ${rejection ? 'error' : 'reply'} cannot affect its replacement`, async t => {
    const h = harness(); t.after(() => h.close());
    let settle;
    h.attach(() => new Promise((resolve, reject) => { settle = rejection ? reject : resolve; }));
    await h.click('btnRecordStart');
    const pending = h.run('samplePid(0x06)');
    const old = h.run('state.connection');
    h.run('disconnectCurrent(); resetUi()');
    assert.equal(h.run('recorder.session.stopReason'), 'disconnected');
    h.attach(async () => [128]);
    await h.click('btnRecordStart');
    settle(rejection ? new Error('late old error') : [140]); await pending;
    h.context.oldConnection = old;
    h.run('onDisconnected(oldConnection)');
    assert.equal(h.run('state.last.size'), 0);
    assert.equal(h.run('recorder.session.samples.length'), 0);
    assert.equal(h.run('state.running'), true);
    await h.run('samplePid(0x06)');
    assert.equal(h.run('recorder.session.samples[0].value'), 0);
  });
}

test('truncated data and missing responses are recorded without corrupting dashboard history', async t => {
  const h = harness(); t.after(() => h.close());
  const results = [[0x0F, 0xA0], null, [0x0F]];
  h.attach(async () => results.shift(), { supported: [0x0C] });
  await h.click('btnRecordStart');
  for (let i = 0; i < 3; i++) await h.run('samplePid(0x0C)');
  assert.deepEqual(plain(h.run('recorder.session.samples.map(s => [s.quality, s.value])')),
    [['valid', 1000], ['missing', null], ['failed', null]]);
  assert.deepEqual(plain(h.run('state.hist.get(0x0C)')), [1000]);
});

test('transport exceptions are recorded once and stop recording with the existing polling error behavior', async t => {
  const h = harness(); t.after(() => h.close());
  h.attach(async () => { throw new Error('mock GATT write failed'); });
  await h.click('btnRecordStart'); await h.run('samplePid(0x06)');
  assert.equal(h.run('recorder.session.samples.length'), 1);
  assert.equal(h.run('recorder.session.samples[0].quality'), 'failed');
  assert.equal(h.run('recorder.session.stopReason'), 'polling-error');
  assert.equal(h.run('state.running'), false);
});

test('thirteenth missing response stops acquisition without duplicating its result', async t => {
  const h = harness(); t.after(() => h.close());
  h.attach(async () => null);
  await h.click('btnRecordStart');
  for (let i = 0; i < 13; i++) await h.run('samplePid(0x06)');
  assert.equal(h.run('recorder.session.samples.length'), 13);
  assert.equal(h.run('recorder.session.counts.missing'), 13);
  assert.equal(h.run('recorder.session.counts.failed'), 0);
  assert.equal(h.run('state.running'), false);
});

test('oxygen location labels require a confirming location bitmap', async t => {
  const h = harness(); t.after(() => h.close());
  h.attach(async () => [100, 255], { supported: [0x13, 0x14, 0x15], sensorMask: 1 });
  await h.click('btnRecordStart');
  await h.run('samplePid(0x14);'); await h.run('samplePid(0x15)');
  assert.equal(h.run('recorder.session.samples[0].locationVerified'), true);
  assert.equal(h.run('recorder.session.samples[1].locationVerified'), false);
  assert.match(h.run('recorder.session.samples[1].label'), /unverified/);
  h.run('state.supported.add(0x1D)');
  assert.equal(h.run('recordingLabel(0x14).locationVerified'), false);
});

test('a late static sensor-layout response cannot verify sensors on a new connection', async t => {
  const h = harness(); t.after(() => h.close());
  let resolve;
  h.attach(() => new Promise(r => { resolve = r; }), { supported: [0x13] });
  const pending = h.run('readStatics(new Set([0x13]))');
  h.run('disconnectCurrent(); resetUi()');
  h.attach(async () => [0]);
  resolve([3]); await pending;
  assert.equal(h.run('state.sensorMask'), null);
  assert.equal(h.run('state.last.has(0x13)'), false);
});

test('default poll order remains five fast PIDs followed by one rotating slow PID', async t => {
  const h = harness(); t.after(() => h.close());
  const seen = [];
  h.attach(async pid => {
    seen.push(pid);
    if (seen.length === 12) h.run('state.running = false');
    return pid === 0x0C ? [0x0F, 0xA0] : [128];
  });
  await h.run('state.fast = FAST_PIDS.slice(); state.slow = [0x06, 0x07]; pollLoop()');
  assert.deepEqual(seen, [0x0C, 0x0D, 0x04, 0x11, 0x05, 0x06,
    0x0C, 0x0D, 0x04, 0x11, 0x05, 0x07]);
});

test('the Elm queue remains serial, recovers after rejection, and no UI status tick sends commands', async t => {
  const h = harness(); t.after(() => h.close());
  const seen = []; let active = 0, maxActive = 0;
  h.context.mockTransport = { async request(command) {
    active++; maxActive = Math.max(maxActive, active); seen.push(command);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    if (command === 'FAIL') throw new Error('mock failure');
    return 'OK';
  } };
  const result = await h.run(`(() => { const client = new Elm(mockTransport);
    return Promise.allSettled([client.cmd('FIRST'), client.cmd('FAIL'), client.cmd('THIRD')]); })()`);
  assert.equal(maxActive, 1);
  assert.deepEqual(seen, ['FIRST', 'FAIL', 'THIRD']);
  assert.deepEqual(plain(result.map(r => r.status)), ['fulfilled', 'rejected', 'fulfilled']);
  h.tick(); h.tick(); assert.equal(seen.length, 3);
});

test('accelerated DemoTransport integration retains gauges, tiles, sparklines, queue and session isolation', async t => {
  const h = harness(); t.after(() => h.close());
  h.run(`var testCommands = [], testActive = 0, testMaxActive = 0;
    const originalDemoRequest = DemoTransport.prototype.request;
    DemoTransport.prototype.request = async function(command, timeout) {
      testCommands.push(command); testActive++; testMaxActive = Math.max(testMaxActive, testActive);
      try { return await originalDemoRequest.call(this, command, timeout); }
      finally { testActive--; }
    };`);
  await h.run('connect(true)');
  assert.equal(h.run('state.running'), true);
  assert.equal(h.run('state.gauges.size'), 3);
  assert.equal(h.run('state.tiles.size'), 31);
  assert.equal(h.run('state.slow.length'), 23);
  assert.equal(h.run('state.sensorMask'), 3);
  await h.click('btnRecordStart');
  await waitFor(() => h.run('!!recorder.session.byPid[0x15] && !!recorder.session.byPid[0x06]'));
  await h.click('btnRecordStop');
  const oldId = h.run('state.connection.id');
  assert.equal(h.run('recorder.session.source'), 'demo');
  assert.match(h.run('recorder.session.metadata.protocol'), /simulated/);
  assert.equal(h.run('recorder.session.counts.failed'), 0);
  assert.equal(h.run('recorder.session.counts.missing'), 0);
  assert.ok(h.run('state.hist.get(0x0C).length > 2'));
  const count = h.run('recorder.session.samples.length');
  await h.run('samplePid(0x06)');
  assert.equal(h.run('recorder.session.samples.length'), count);
  await h.run('connect(true)');
  assert.notEqual(h.run('state.connection.id'), oldId);
  assert.equal(h.run('recorder.session.samples.length'), count); // Retain until explicit new recording.
  await h.click('btnRecordStart');
  assert.equal(h.run('recorder.session.samples.length'), 0);
  h.pagehide();
  assert.equal(h.run('recorder.session.stopReason'), 'page-hidden');
  assert.equal(h.run('state.running'), false);
  assert.equal(h.run('testMaxActive'), 1);
  assert.equal(h.run("testCommands.includes('04')"), false);
});

test('DemoTransport with its normal delays records native readings and stops on adapter disconnect', async t => {
  const h = harness({ fastTimers: false }); t.after(() => h.close());
  h.run(`var normalCommands = [];
    const normalRequest = DemoTransport.prototype.request;
    DemoTransport.prototype.request = function(command, timeout) {
      normalCommands.push(command); return normalRequest.call(this, command, timeout);
    };`);
  await h.run('connect(true)');
  h.run('state.imperial = true');
  await h.click('btnRecordStart');
  await waitFor(() => h.run('!!recorder.session.byPid[0x15]'), 15000);
  h.tick();
  assert.match(h.node('recordingSource').textContent, /SIMULATED DATA/);
  assert.equal(h.run('recorder.session.samples.find(s => s.pid === 0x05).unit'), '°C');
  assert.equal(h.run('recorder.session.samples.find(s => s.pid === 0x0D).unit'), 'km/h');
  assert.ok(h.run('recorder.summary().series.find(s => s.pid === 0x0C).rateHz > 0'));
  assert.equal(h.run('recorder.session.samples.find(s => s.pid === 0x14).locationVerified'), true);
  h.run('transport.disconnect()');
  assert.equal(h.run('recorder.session.stopReason'), 'disconnected');
  assert.equal(h.run('state.running'), false);
  assert.equal(h.run("normalCommands.includes('04')"), false);
});
