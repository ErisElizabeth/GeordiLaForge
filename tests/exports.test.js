'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadFiles, plain, recorderFixture, harness } = require('./helpers.js');
const { recordedSession } = require('./export-fixtures.js');

function exportApi() {
  const context = vm.createContext({ structuredClone });
  loadFiles(context, ['dtc-db.js', 'graphs.js', 'exports.js', 'report.js']);
  return vm.runInContext(`({ prepareDiagnosticExport, diagnosticExportReady, diagnosticCsv,
    diagnosticCsvCell, diagnosticReportDocument, diagnosticExportStatistics, splitDiagnosticNotes,
    diagnosticExportFilename, captureRecordingTroubleCodes })`, context);
}

function parseCsv(csv) {
  const rows = [], row = []; let value = '', quoted = false;
  const text = csv.replace(/^\ufeff/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && c === ',') { row.push(value); value = ''; }
    else if (!quoted && c === '\r' && text[i + 1] === '\n') { row.push(value); rows.push(row.splice(0)); value = ''; i++; }
    else value += c;
  }
  assert.equal(quoted, false); return rows;
}

test('exports require a stopped, structurally complete recording; an empty stopped session is allowed', () => {
  const api = exportApi();
  for (const value of [null, {}, {...recordedSession(), endedAt:null}, {...recordedSession(), endedAt:'invalid date'},
    {...recordedSession(), endedElapsedMs:null}]) {
    assert.equal(api.diagnosticExportReady(value), false);
    assert.throws(() => api.prepareDiagnosticExport(value), /Stop a complete/);
  }
  assert.equal(api.diagnosticExportReady(recordedSession(0)), true);
});

test('export uses an independent snapshot and never modifies original measurements, metadata or notes', () => {
  const api = exportApi(), original = recordedSession(); const before = JSON.stringify(original);
  const exported = api.prepareDiagnosticExport(original, {omitIdentifiers:false, includeNotes:true});
  api.diagnosticCsv(exported); api.diagnosticReportDocument(exported);
  assert.equal(JSON.stringify(original), before);
  original.samples[0].value = 99; original.notes = 'Changed later';
  assert.equal(exported.samples[0].value, 0.65);
  assert.match(exported.notes, /Warm idle/);
});

test('identifier omission removes known identifiers from every included text field, including notes and failures', () => {
  const api = exportApi(), source = recordedSession();
  source.notes = 'VIN kndjf724x77012345 for Æther. Another VIN: 1HGCM82633A004352';
  source.samples[0].reason = 'KNDJF724X77012345 / Æther';
  source.samples[1].label = 'KNDJF724X77012345';
  source.metadata.privateExtra = 'must not be exported';
  const exported = api.prepareDiagnosticExport(source, {includeNotes:true});
  const combined = JSON.stringify(exported) + api.diagnosticCsv(exported) + api.diagnosticReportDocument(exported).html;
  for (const identifier of ['KNDJF724X77012345','kndjf724x77012345','1HGCM82633A004352','Æther','must not be exported']) {
    assert.equal(combined.includes(identifier), false, identifier);
  }
  assert.equal(exported.metadata.vin, null);
  assert.match(combined, /REDACTED/);
});

test('identifiers and notes are included only through explicit export options', () => {
  const api = exportApi(), original = recordedSession();
  const safe = api.prepareDiagnosticExport(original);
  assert.equal(safe.notes, null); assert.equal(safe.metadata.vin, null);
  const included = api.prepareDiagnosticExport(original, {omitIdentifiers:false, includeNotes:true});
  assert.equal(included.metadata.vin, original.metadata.vin);
  assert.equal(included.notes, original.notes);
  assert.ok(api.diagnosticReportDocument(included).html.includes(original.metadata.vin));
  assert.equal(api.diagnosticExportFilename(included, 'csv').includes(original.metadata.vin), false);
});

test('CSV has consistent columns, all results and a separate recording-metadata row', () => {
  const api = exportApi(), original = recordedSession(19);
  const exported = api.prepareDiagnosticExport(original, {includeNotes:true, omitIdentifiers:false});
  const rows = parseCsv(api.diagnosticCsv(exported)), header = rows[0];
  assert.equal(rows.length, original.samples.length + 2);
  assert.ok(rows.every(row => row.length === header.length));
  const column = name => header.indexOf(name);
  assert.equal(rows[1][column('row_type')], 'recording');
  assert.equal(rows[1][column('recording_notes')], original.notes);
  assert.equal(rows[2][column('row_type')], 'sample');
  assert.equal(rows[4][column('value')], '-12.5');
  assert.equal(rows[4][column('native_unit')], '%');
  assert.ok(rows.some(row => row[column('pid_hex')] === '0F')); // Not in diagnostic graph groups.
  assert.ok(rows.slice(1).every(row => row[column('source_notice')].includes('SIMULATED DATA')));
  assert.ok(rows.slice(2).every(row => row[column('recording_notes')] === ''));
});

test('CSV safely quotes commas, quotation marks, CRLF and user-entered Unicode text', () => {
  const api = exportApi(), source = recordedSession(1);
  source.notes = 'Warm, "idle"\r\nÆther & °C'; source.samples[0].label = 'Sensor, "one"\nsecond line';
  const rows = parseCsv(api.diagnosticCsv(api.prepareDiagnosticExport(source, {omitIdentifiers:false, includeNotes:true})));
  assert.equal(rows[1][rows[0].indexOf('recording_notes')], source.notes);
  assert.equal(rows[2][rows[0].indexOf('measurement')], source.samples[0].label);
});

test('spreadsheet formula-like text is neutralized while numeric negative readings are preserved', () => {
  const api = exportApi();
  for (const value of ['=1+1', '+SUM(1,2)', '-2+3', '@SUM(A1:A2)', '\t=1+1', '\r\n=1+1', '  =1+1', '\u200b=1+1']) {
    assert.ok(api.diagnosticCsvCell(value).startsWith('"\''), JSON.stringify(value));
  }
  assert.equal(api.diagnosticCsvCell(-12.5), '-12.5');
  assert.equal(api.diagnosticCsvCell(0), '0');
  assert.equal(api.diagnosticCsvCell('ordinary text'), '"ordinary text"');
});

test('CSV missing and failed results have empty values and preserve their quality and explanation', () => {
  const api = exportApi(), source = recordedSession(2);
  source.samples[0] = {...source.samples[0], value:null, quality:'missing', reason:'NO DATA or timeout'};
  source.samples[1] = {...source.samples[1], value:null, quality:'failed', reason:'Truncated, "invalid" payload'};
  const rows = parseCsv(api.diagnosticCsv(api.prepareDiagnosticExport(source))), h = rows[0];
  assert.equal(rows[2][h.indexOf('value')], '');
  assert.equal(rows[2][h.indexOf('quality')], 'missing');
  assert.equal(rows[3][h.indexOf('failure_explanation')], source.samples[1].reason);
});

test('report uses the shared graph models across the full session and escapes operator markup', () => {
  const api = exportApi(), source = recordedSession(40);
  source.notes = '<img src="https://invalid.example/leak" onerror="alert(1)">\n<script>bad()</script> & "notes"';
  const exported = api.prepareDiagnosticExport(source, {includeNotes:true});
  const report = api.diagnosticReportDocument(exported);
  assert.equal(report.models.length, 5);
  assert.equal(report.models[0].range.endMs, source.endedElapsedMs);
  assert.match(report.html, /Geordi LaForge \| OBD-II Diagnostic Report/);
  assert.equal(report.html.includes('<script>bad()'), false);
  assert.equal(report.html.includes('<img src='), false);
  assert.match(report.html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(report.html, /size: Letter/);
  assert.match(report.html, /No automatic fault diagnosis/);
  assert.match(report.html, /No eligible DTC refresh/);
});

test('code snapshots are captured only within the same active recording and connection', () => {
  const api = exportApi(), f = recorderFixture();
  const before = f.recorder.captureRequest(1); f.start();
  assert.equal(api.captureRecordingTroubleCodes(f.recorder, before, ['P0420'], []), false);
  const token = f.recorder.captureRequest(1); f.advance(200);
  assert.equal(api.captureRecordingTroubleCodes(f.recorder, token, ['P0420'], ['P0171']), true);
  f.recorder.stop();
  const exported = api.prepareDiagnosticExport(f.recorder.session);
  assert.deepEqual(plain(exported.metadata.troubleCodes.stored), ['P0420']);
  const html = api.diagnosticReportDocument(exported).html;
  assert.match(html, /Catalyst system efficiency below threshold/);
  f.start();
  assert.equal(api.captureRecordingTroubleCodes(f.recorder, token, ['P0301'], []), false);
});

test('unrelated or out-of-window code snapshots are unavailable and empty decoded results are inconclusive', () => {
  const api = exportApi(), source = recordedSession();
  source.metadata.troubleCodes = {recordingId:'other', connectionId:2, requestElapsedMs:0, elapsedMs:10, stored:['P0420'],pending:[]};
  assert.equal(api.prepareDiagnosticExport(source).metadata.troubleCodes, null);
  source.metadata.troubleCodes.recordingId = source.id; source.metadata.troubleCodes.elapsedMs = 999999;
  assert.equal(api.prepareDiagnosticExport(source).metadata.troubleCodes, null);
  source.metadata.troubleCodes.elapsedMs = 10; source.metadata.troubleCodes.stored = [];
  const html = api.diagnosticReportDocument(api.prepareDiagnosticExport(source)).html;
  assert.match(html, /absence of codes is unconfirmed/);
  assert.equal(html.includes('all clear'), false);
});

test('empty reports clearly state absent telemetry, VIN and protocol without dashboard fallback', () => {
  const api = exportApi(), source = recordedSession(0); source.metadata = {};
  const report = api.diagnosticReportDocument(api.prepareDiagnosticExport(source, {omitIdentifiers:false}));
  assert.match(report.html, /EMPTY RECORDING/);
  assert.match(report.html, /VIN not captured/);
  assert.match(report.html, /Unavailable - not captured/);
  assert.ok(report.models.every(model => model.entries.length === 0));
  assert.equal(parseCsv(api.diagnosticCsv(api.prepareDiagnosticExport(source))).length, 2);
});

test('report explicitly marks unsupported oxygen sensors without inventing voltage results', () => {
  const api = exportApi(), source = recordedSession(0);
  source.metadata.supportedPids = [6, 7, 12]; source.metadata.measurements = [];
  const report = api.diagnosticReportDocument(api.prepareDiagnosticExport(source));
  assert.ok(report.models[0].series.every(series => series.availability === 'Not advertised by this ECU'));
  assert.equal(report.models[0].entries.length, 0);
  assert.match(report.html, /Not advertised by this ECU/);
});

test('note chunks preserve Unicode and newlines while bounding individual layout blocks', () => {
  const api = exportApi();
  for (const notes of ['x'.repeat(4000), '\n'.repeat(4000), ('Æther 🚙\r\n"idle", <test>\n').repeat(130)]) {
    const chunks = api.splitDiagnosticNotes(notes);
    assert.equal(chunks.join(''), notes);
    assert.ok(chunks.every(chunk => chunk.length <= 602));
    assert.ok(chunks.every(chunk => (chunk.match(/\n/g) || []).length <= 12));
    assert.ok(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk)));
  }
});

test('20,000-result exports retain every observation and native negative values', () => {
  const api = exportApi(), source = recordedSession(20000), before = JSON.stringify(source);
  const exported = api.prepareDiagnosticExport(source), csv = api.diagnosticCsv(exported), rows = parseCsv(csv);
  assert.equal(rows.length, 20002);
  assert.equal(rows[20001][rows[0].indexOf('elapsed_ms')], String(source.samples.at(-1).elapsedMs));
  const stats = api.diagnosticExportStatistics(exported);
  assert.ok(stats.series.some(series => series.min === -12.5));
  assert.equal(stats.counts.valid, 20000);
  assert.equal(JSON.stringify(source), before);
});

test('export buttons remain disabled while recording and do not stop acquisition when enabled', async t => {
  const h = harness(); t.after(() => h.close()); h.attach(async () => [128]);
  await h.click('btnRecordStart'); h.tick();
  assert.equal(h.node('btnExportReport').disabled, true);
  await h.run('samplePid(6)'); await h.click('btnRecordStop');
  assert.equal(h.node('btnExportReport').disabled, false);
  assert.equal(h.node('btnExportCsv').disabled, false);
  assert.equal(h.run('state.running'), true);
});

test('existing DTC refresh adds a recording snapshot without additional adapter calls', async t => {
  const h = harness(); t.after(() => h.close()); h.attach(async () => [128]);
  h.run(`var dtcCalls = []; elm.readDtcs = async mode => { dtcCalls.push(mode); return mode === 3 ? [] : ['P0420']; };`);
  await h.click('btnRecordStart'); await h.run('refreshDtcs(new Set())'); await h.click('btnRecordStop');
  assert.deepEqual(plain(h.run('dtcCalls')), [3, 7]);
  assert.deepEqual(plain(h.run('recorder.session.metadata.troubleCodes.pending')), ['P0420']);
});

test('CSV UI retains one download URL, respects privacy defaults and releases it on page close', async t => {
  const h = harness(); t.after(() => h.close());
  const revoked = [], downloads = [], blobs = [];
  h.context.Blob = Blob;
  h.context.URL = {createObjectURL(blob) {blobs.push(blob); return 'blob:test-' + blobs.length;},
    revokeObjectURL(url) {revoked.push(url);} };
  const originalCreate = h.context.document.createElement;
  h.context.document.createElement = tag => tag === 'a' ? {
    click() {downloads.push({href:this.href,filename:this.download});}, remove() {},
  } : originalCreate(tag);
  h.context.document.body = {appendChild() {}};
  h.context.fixture = recordedSession(10);
  h.run('recorder.session = fixture');
  h.node('exportOmitIdentifiers').checked = true; h.node('exportIncludeNotes').checked = false;
  await h.click('btnExportCsv');
  assert.equal(downloads.length, 1); assert.equal(revoked.length, 0);
  const contents = await blobs[0].text();
  assert.equal(contents.includes(h.context.fixture.metadata.vin), false);
  assert.equal(contents.includes('Warm idle'), false);
  await h.click('btnExportCsv');
  assert.deepEqual(revoked, ['blob:test-1']);
  h.pagehide();
  assert.deepEqual(revoked, ['blob:test-1','blob:test-2']);
  assert.equal(h.run('diagnosticExports.downloadUrl'), null);
});

module.exports = { exportApi, recordedSession, parseCsv };
