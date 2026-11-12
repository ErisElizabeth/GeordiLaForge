'use strict';

const DIAGNOSTIC_REPORT_TITLE = 'Geordi LaForge | OBD-II Diagnostic Report';
const reportEscape = value => diagnosticExportText(value).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reportNumber = value => Number.isFinite(value) ? String(Number(value.toFixed(3))) : 'Unavailable';

function splitDiagnosticNotes(text) {
  const blocks = [];
  for (let start = 0; start < text.length;) {
    let end = start, lines = 0;
    while (end < text.length && end - start < 600 && lines < 12) if (text[end++] === '\n') lines++;
    if (end < text.length && end - start === 600) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline > start + 200) end = newline + 1;
      else {
        const space = text.lastIndexOf(' ', end - 1);
        if (space > start + 300) end = space + 1;
      }
    }
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end++;
    if (end < text.length && text[end - 1] === '\r' && text[end] === '\n') end++;
    blocks.push(text.slice(start, end)); start = end;
  }
  return blocks;
}

function diagnosticReportRowGroups(items) {
  if (!items.length) return [];
  const size = Math.ceil(items.length / Math.ceil(items.length / 10)), groups = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}

function diagnosticReportDocument(exported) {
  const stats = diagnosticExportStatistics(exported);
  const index = new TelemetryGraphIndex(); index.update(exported);
  const models = diagnosticGraphSpecs(exported).map(spec => buildDiagnosticGraph(index, spec,
    diagnosticGraphRange(exported.endedElapsedMs), exported.endedElapsedMs));
  const block = (title, content) => '<section class="report-block"><h2>' + reportEscape(title) + '</h2>' + content + '</section>';
  const table = (heads, rows) => '<table><thead><tr>' + heads.map(h => '<th scope="col">' + reportEscape(h) + '</th>').join('') +
    '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map(cell => '<td>' + reportEscape(cell) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
  const blocks = [];
  const identity = exported.privacy.omitIdentifiers ? 'Omitted by operator'
    : exported.metadata.vin || 'Unavailable - VIN not captured in recording metadata';
  const mode = exported.metadata.polling?.requestedMode || exported.metadata.polling?.mode;
  const profile = { dashboard: 'Dashboard default', focused: 'Focused diagnostics',
    'oxygen-comparison': 'Oxygen Sensor Comparison', 'trim-comparison': 'Fuel Trim Comparison' }[mode];
  blocks.push(block('Recording summary', table(['Field', 'Recorded information'], [
    ['Data source', diagnosticSourceNotice(exported.source)], ['Recording ID', exported.id],
    ['Vehicle VIN', identity], ...(exported.metadata.vehicleName ? [['Vehicle name', exported.metadata.vehicleName]] : []),
    ['Start time (UTC)', exported.startedAt || 'Unavailable'], ['Stop time (UTC)', exported.endedAt],
    ['Duration', reportNumber(exported.endedElapsedMs / 1000) + ' s (' + reportNumber(exported.endedElapsedMs) + ' ms)'],
    ['Communication protocol', exported.metadata.protocol || 'Unavailable - not captured'],
    ['Sampling profile at start', profile || mode || 'Unavailable - not captured'],
    ['Recording ended because', exported.stopReason || 'Unavailable'],
    ['Recorded results', exported.samples.length + ': ' + stats.counts.valid + ' valid, ' + stats.counts.missing +
      ' missing, ' + stats.counts.failed + ' failed' + (stats.counts.other ? ', ' + stats.counts.other + ' unrecognized quality' : '')],
  ])));
  blocks.push(block('Evidence and scope', '<p>This document describes the completed recording, independent of the dashboard\'s selected graph window. ' +
    'Vehicle and protocol metadata were saved at recording start and may have been queried during connection initialization. ' +
    'No live dashboard values or later connections have been substituted. Browser receipt timestamps are not the ECU\'s internal measurement times; request durations include queue wait.</p>' +
    '<p><strong>Diagnostic interpretation:</strong> No automatic fault diagnosis is provided. Sparse, sequential oxygen readings cannot establish switching speed, simultaneous sensor response, or catalytic-converter failure. ' +
    'Unobserved changes between readings remain unknown.</p>' +
    (!exported.samples.length ? '<p class="notice">EMPTY RECORDING: No telemetry results were captured. Graphs and rates are unavailable.</p>' : '') +
    (exported.privacy.omitIdentifiers ? '<p>Privacy: vehicle-identifying fields omitted; known identifiers and VIN-like strings redacted from included text. ' +
      'Operator notes are ' + (exported.privacy.includeNotes ? 'included by explicit selection; review them for other personal information.' : 'omitted.') + '</p>' : '<p>Privacy: captured vehicle identification is included.</p>')));
  const codes = exported.metadata.troubleCodes;
  if (!codes) {
    blocks.push(block('Stored and pending trouble codes', '<p>Stored codes: <strong>Unavailable.</strong> Pending codes: <strong>Unavailable.</strong></p>' +
      '<p>No eligible DTC refresh was captured during this recording. Values shown elsewhere on the dashboard have not been used. Export does not request vehicle data.</p>'));
  } else {
    blocks.push(block('Trouble-code snapshot provenance', '<p>Most recent existing DTC refresh captured at ' + reportEscape(codes.capturedAt) +
      ' (' + reportNumber(codes.elapsedMs / 1000) + ' s elapsed). Descriptions below are from the application\'s generic DTC reference, not a manufacturer-specific diagnosis.</p>' +
      '<p>An empty decoded result does not prove that no codes exist: the existing adapter parser does not establish response quality for an empty DTC result.</p>'));
    for (const kind of ['stored', 'pending']) {
      const values = codes[kind], title = kind === 'stored' ? 'Stored trouble codes' : 'Pending trouble codes';
      if (!values.length) blocks.push(block(title, '<p>No codes decoded in the captured refresh; absence of codes is unconfirmed.</p>'));
      for (let offset = 0; offset < values.length; offset += 8) blocks.push(block(title + (offset ? ' (continued)' : ''),
        table(['Captured code', 'Generic description'], values.slice(offset, offset + 8).map(code =>
          [code, DTC_DB[code] || 'Description unavailable; verify against a vehicle-specific reference']))));
    }
  }
  for (let offset = 0; offset < exported.events.length; offset += 8) blocks.push(block('Recording and connection boundaries' + (offset ? ' (continued)' : ''),
    table(['Event', 'Timestamp (UTC)', 'Elapsed (ms)', 'Reason'], exported.events.slice(offset, offset + 8).map(event =>
      [event.type, event.timestamp || 'Unavailable', reportNumber(event.elapsedMs), event.reason || 'Not recorded']))));
  for (const model of models) {
    const legends = model.series.map((series, i) => '<li><strong class="series-' + i + '">' + (i ? '■ ' : '● ') +
      reportEscape(series.label) + ' (' + reportEscape(model.unit) + '), PID ' + graphPidText(series.pid) + '</strong><br>' +
      reportEscape(series.availability) + '. ' + series.valid + ' valid / ' + series.missing + ' missing / ' + series.failed + ' failed or unplottable. ' +
      'Valid rate: ' + (series.rateHz === null ? 'unavailable (need distinct valid times)' : reportNumber(series.rateHz) + ' Hz') +
      '. Latest valid age at stop: ' + (series.ageMs === null ? 'unavailable' : reportNumber(series.ageMs / 1000) + ' s') +
      (series.invalidTimes ? '. Invalid elapsed times, not plotted: ' + series.invalidTimes : '') + '.</li>').join('');
    blocks.push('<figure class="report-block"><h2>' + reportEscape(model.title) + '</h2><ul class="legend">' + legends + '</ul>' +
      '<canvas id="report-' + model.id + '" width="1402" height="560" aria-label="' + reportEscape(model.title) + '"></canvas>' +
      '<p class="small">Filled markers are actual measurements; open circles on the gap rows are missing results and crosses are failed or unplottable results. ' +
      'No connecting lines, interpolation, or smoothing. Units are native recorded units. O2 bank/sensor names require verified location metadata. ' +
      (exported.endedElapsedMs < 1000 ? 'The axis extends to 1 s for legibility; no additional measurements are implied.' : '') + '</p></figure>');
  }
  const numeric = stats.series.filter(s => s.min !== null);
  const ranges = diagnosticReportRowGroups(numeric), qualityGroups = diagnosticReportRowGroups(stats.series);
  for (let part = 0; part < ranges.length; part++) blocks.push(block('Recorded operating ranges' + (part ? ' (continued)' : ''),
    '<p class="small">Observed extrema of valid numeric results, not specification limits or diagnostic thresholds. ' +
      'Report numbers are rounded to at most three decimal places; CSV retains recorded numeric values.</p>' +
    table(['PID / measurement', 'Unit', 'Minimum', 'Maximum'], ranges[part].map(s =>
      [s.pid.toString(16).toUpperCase().padStart(2, '0') + ' / ' + s.label, s.unit, reportNumber(s.min), reportNumber(s.max)]))));
  for (let part = 0; part < qualityGroups.length; part++) blocks.push(block('Sampling and data quality' + (part ? ' (continued)' : ''),
    table(['PID / measurement', 'Unit', 'Valid', 'Missing', 'Failed', 'Valid Hz'], qualityGroups[part].map(s =>
      [s.pid.toString(16).toUpperCase().padStart(2, '0') + ' / ' + s.label, s.unit, s.valid, s.missing, s.failed + s.other,
        s.rateHz === null ? 'Unavailable' : reportNumber(s.rateHz)]))));
  blocks.push(block('Coverage and data-quality limitations', '<p>Missing results have no recorded value. They may reflect NO DATA, a timeout, or an unrecognized response. ' +
    'Failed results retain their recorded explanation in the CSV. Rates use actual valid-sample intervals; aggregate PID throughput is not an individual sensor\'s sampling rate.</p>' +
    '<p>Unsupported sensors are not requested. An advertised PID without recorded results is not evidence of a failed sensor. ' +
    'Results outside the graph groups remain part of the recording and CSV. ' +
    (exported.metadata.supportedPids ? 'ECU-advertised PID support was saved with this recording.' : 'ECU PID support information was not captured.') + '</p>'));
  const noteParts = exported.notes === null ? [] : splitDiagnosticNotes(exported.notes);
  if (!noteParts.length) blocks.push(block('Operator notes', '<p>' + (exported.notes === null ? 'Omitted by operator export setting.' : 'No operator notes entered.') + '</p>'));
  else for (let i = 0; i < noteParts.length; i++) blocks.push(block('Operator notes' + (i ? ' (continued)' : ''),
    '<pre class="notes">' + reportEscape(noteParts[i]) + '</pre>'));
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src \'none\'">' +
    '<title>' + reportEscape(DIAGNOSTIC_REPORT_TITLE) + '</title><style>' + DIAGNOSTIC_REPORT_CSS + '</style></head><body>' +
    '<main id="reportPages"></main><main id="reportFlow">' + blocks.join('') + '</main></body></html>';
  return { html, models };
}

const DIAGNOSTIC_REPORT_CSS = `
@page { size: Letter; margin: 0.6in; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; color: #171717; background: #e6e6e6; font: 10.5pt/1.35 Arial, sans-serif; }
#reportFlow { width: 7.3in; margin: auto; background: white; }
.report-page { width: 7.3in; height: 9.7in; margin: 16px auto; background: white; display: flex; flex-direction: column; overflow: visible; }
.report-header { flex: none; padding-bottom: 10px; border-bottom: 2px solid #222; margin-bottom: 12px; }
.report-title { margin: 0 0 5px; font-size: 14pt; font-weight: 700; }
.source-warning { font-size: 11pt; font-weight: 800; color: #171717; }
.page-body { flex: 1; min-height: 0; display: flow-root; }
.report-footer { flex: none; margin-top: 10px; border-top: 1px solid #666; padding-top: 5px; font-size: 8.5pt; }
.report-block { margin: 0; padding: 0 0 12px; break-inside: avoid; }
h2 { font-size: 12pt; margin: 0 0 7px; }
p { margin: 0 0 8px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 9pt; }
th, td { padding: 5px; text-align: left; vertical-align: top; border-bottom: 1px solid #bbb; overflow-wrap: anywhere; }
th { border-bottom: 2px solid #555; }
table th:first-child, table td:first-child { width: 35%; }
.legend { padding-left: 18px; margin: 0 0 8px; font-size: 9pt; }
.legend li { margin: 0 0 7px; }
.series-0 { color: #0064a5; } .series-1 { color: #ad3d00; }
canvas { display: block; width: 7.3in; height: 280px; margin: 0 0 8px; }
.small { font-size: 9pt; } .notice { border: 2px solid #222; padding: 8px; font-weight: 700; }
.notes { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font: inherit; }
@media screen { .report-page { outline: 1px solid #aaa; } }
@media print { html, body { background: white; } #reportFlow { display: none; }
  .report-page { margin: 0; break-after: page; } .report-page:last-child { break-after: auto; }
}
`;

function paginateDiagnosticReport(doc, exported) {
  const container = doc.querySelector('#reportPages'), flow = doc.querySelector('#reportFlow');
  const blocks = [...flow.children], pages = [];
  const add = (tag, cls, text) => { const node = doc.createElement(tag); node.className = cls;
    if (text !== undefined) node.textContent = text; return node; };
  function newPage() {
    const page = add('article', 'report-page'), header = add('header', 'report-header');
    header.appendChild(add('div', 'report-title', DIAGNOSTIC_REPORT_TITLE));
    header.appendChild(add('div', 'source-warning', diagnosticSourceNotice(exported.source)));
    page.appendChild(header);
    const body = add('div', 'page-body'); page.appendChild(body);
    const footer = add('footer', 'report-footer', 'Recording ' + exported.id + ' | Page 000 of 000'); page.appendChild(footer);
    container.appendChild(page); pages.push({ page, body, footer }); return body;
  }
  let body = newPage();
  for (const content of blocks) {
    body.appendChild(content);
    if (body.scrollHeight > body.clientHeight + 1) {
      if (body.children.length > 1) { body = newPage(); body.appendChild(content); }
      if (body.scrollHeight > body.clientHeight + 1) throw new Error('A report block exceeds the printable page. Printing has been disabled.');
    }
  }
  flow.remove();
  for (let i = 0; i < pages.length; i++) pages[i].footer.textContent = 'Recording ' + exported.id + ' | Page ' + (i + 1) + ' of ' + pages.length;
  doc.documentElement.dataset.reportReady = 'true';
  return pages.length;
}

async function renderDiagnosticReport(doc, exported, report) {
  if (doc.fonts?.ready) await doc.fonts.ready;
  for (let i = 0; i < report.models.length; i++) {
    const canvas = doc.querySelector('#report-' + report.models[i].id);
    if (!canvas || !renderDiagnosticCanvas(canvas, report.models[i], {
      width: 700.8, height: 280, pixelRatio: 2, palette: DIAGNOSTIC_GRAPH_PALETTE })) {
      throw new Error('A report graph could not be rendered. Printing has been disabled.');
    }
  }
  const pages = paginateDiagnosticReport(doc, exported);
  // Give the browser two paint opportunities before enabling native printing.
  const view = doc.defaultView;
  await new Promise(resolve => view.requestAnimationFrame(() => view.requestAnimationFrame(resolve)));
  return pages;
}
