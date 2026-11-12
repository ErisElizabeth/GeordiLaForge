'use strict';

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let transport = null, elm = null, pollSession = 0;
let connectionSerial = 0;
const recorder = new TelemetryRecorder();
const diagnosticGraphs = new DiagnosticGraphs();
const diagnosticExports = new DiagnosticExports(() => recorder.session);
const state = {
  running: false,
  busy: false, connection: null, supported: new Set(), sensorMask: null, vehicle: {},
  pollingMode: 'dashboard', pollingRevision: 0, focusPlan: null,
  capabilities: null, alternativeMask: null,
  voltageAvailable: false,
  fast: [], slow: [], slowIdx: 0, cycle: 0,
  tiles: new Map(),      // pid -> {root, valueEl, unitEl, canvas, barEl, def}
  hist: new Map(),       // pid -> number[]
  last: new Map(),       // pid -> decoded value in native units, or text
  gauges: new Map(),     // pid -> {update}
  imperial: localStorage.getItem('units') === 'imperial',
  theme: localStorage.getItem('theme') || 'auto',
  failures: 0,
};

/* ---------------- sampling mode ---------------- */
function ensureCapabilities() {
  if (!state.capabilities) {
    state.capabilities = new EcuCapabilities(state.supported);
    if (state.sensorMask !== null) state.capabilities.masks[0x13] = state.sensorMask;
    if (state.alternativeMask !== null) state.capabilities.masks[0x1D] = state.alternativeMask;
  }
  return state.capabilities;
}

function activePollingPlan() { return state.pollingMode !== 'dashboard' && state.focusPlan?.active ? state.focusPlan : null; }

function pollingMetadata() {
  if (state.pollingMode !== 'dashboard' && state.focusPlan) {
    return { mode: state.focusPlan.active ? state.pollingMode : 'dashboard', requestedMode: state.pollingMode,
      policy: state.focusPlan.description() };
  }
  return { mode: 'dashboard', requestedMode: 'dashboard',
    policy: 'Dashboard default: fast PIDs every round plus one rotating slow PID; no focused retry delays.' };
}

function setPollingMode(mode) {
  if (!['dashboard', 'focused', 'oxygen-comparison', 'trim-comparison'].includes(mode) || !state.running || state.busy || recorder.active) {
    renderPollingMode(); return false;
  }
  if (mode !== state.pollingMode) {
    state.pollingMode = mode; state.pollingRevision++;
    state.focusPlan = mode === 'focused' ? new FocusedPollingPlan(state.supported, state.sensorMask)
      : mode === 'dashboard' ? null : new ComparisonPollingPlan(mode, ensureCapabilities());
    if (state.focusPlan) { state.focusPlan.source = state.connection.source; state.focusPlan.latency = new Map(); }
    if (state.focusPlan instanceof ComparisonPollingPlan) $('#voltChip').classList.add('hidden');
    else if (state.voltageAvailable) $('#voltChip').classList.remove('hidden');
    log('sys', pollingMetadata().policy);
  }
  renderPollingMode(); return true;
}

function renderPollingMode() {
  $('#pollingMode').value = state.pollingMode;
  $('#pollingMode').disabled = !state.running || state.busy || recorder.active;
  const source = state.connection?.source || state.focusPlan?.source;
  $('#pollingModeStatus').textContent = (source === 'demo' ? 'SIMULATED DATA — ' : '') +
    (!state.running ? 'Polling stopped. Connect or enter Demo mode to choose a sampling mode.' : pollingMetadata().policy) +
    (recorder.active ? ' Stop the recording to change modes.' : '');
  $('#focusedSampling').hidden = state.pollingMode === 'dashboard' || !state.focusPlan;
  const rows = $('#focusedSamplingRows'); rows.innerHTML = '';
  $('#focusedExclusions').textContent = state.focusPlan ? state.focusPlan.excluded.map(item =>
    (item.pid === undefined ? item.label : 'PID ' + hex2(item.pid)) + ': ' + item.reason).join('; ') : '';
  if (!state.focusPlan?.active) return;
  for (const stats of state.focusPlan.summary(performance.now())) {
    const row = el('tr');
    const label = recordingLabel(stats.pid).label;
    const latency = state.focusPlan.latency?.get(stats.pid);
    const pending = state.focusPlan.canValidate?.(stats.pid, performance.now());
    for (const value of ['01 ' + hex2(stats.pid) + ' · ' + label, stats.valid, stats.missing, stats.failed,
      stats.rateHz === null ? '—' : stats.rateHz.toFixed(3),
      stats.ageMs === null ? 'No valid reading' : (stats.ageMs / 1000).toFixed(1) + ' s',
      stats.retryMs ? 'Retry in ' + Math.ceil(stats.retryMs / 1000) + ' s' : pending ? 'Awaiting decode validation' : 'Eligible',
      latency ? (latency.total / latency.count).toFixed(1) + ' ms' : '—',
      latency ? latency.last.toFixed(1) + ' ms' : '—']) {
      row.appendChild(el('td', null, String(value)));
    }
    rows.appendChild(row);
  }
}

$('#pollingMode').addEventListener('change', () => setPollingMode($('#pollingMode').value));

function renderCapabilities() {
  const inventory = state.capabilities;
  $('#capabilitiesEmpty').hidden = !!inventory;
  $('#capabilitiesContent').hidden = !inventory;
  if (!inventory) return;
  const advertised = inventory.rows(), decoded = advertised.filter(row => row.decoded).length;
  $('#capabilitiesSummary').textContent = advertised.length + ' advertised Mode 01 PIDs; ' + decoded +
    ' with decoders; ' + (advertised.length - decoded) + ' without decoders; ' +
    advertised.filter(row => row.decodedSuccessfully).length + ' successfully decoded on this connection.';
  if ($('#capabilitiesDetails').open === false) return;
  const rows = $('#capabilitiesRows'); rows.innerHTML = '';
  for (const info of inventory.rows($('#capabilitiesFilter').value === 'references')) {
    let suitability = info.suitability;
    const plan = state.focusPlan;
    if (plan instanceof ComparisonPollingPlan && info.advertised && info.decoded) {
      suitability = plan.candidates.includes(info.pid)
        ? plan.eligible(info.pid, performance.now()) ? 'Eligible for selected profile'
          : plan.canValidate(info.pid, performance.now()) ? 'Candidate: awaiting successful decoding' : 'Waiting for retry'
        : 'Outside selected comparison profile';
      if (info.pid >= 0x14 && info.pid <= 0x1B && !info.location) suitability = 'O2 location unverified';
    }
    const row = el('tr');
    for (const value of [hex2(info.pid), info.label, info.classification,
      info.lastQuality ? (info.decodedSuccessfully ? 'Validated; latest ' : 'Latest ') + info.lastQuality +
        (info.reason ? ': ' + info.reason : '') : 'Not observed',
      suitability, info.responseMs === null ? '—' : info.responseMs.toFixed(1) + ' ms']) row.appendChild(el('td', null, value));
    rows.appendChild(row);
  }
}
$('#capabilitiesFilter').addEventListener('change', renderCapabilities);
$('#capabilitiesDetails').addEventListener('toggle', renderCapabilities);

/* ---------------- recording ---------------- */
function recordingLabel(pid) {
  const def = PIDS[pid];
  if (pid >= 0x14 && pid <= 0x1B) {
    if (state.capabilities) {
      const location = oxygenLocation(pid, state.supported, state.capabilities.masks);
      return { label: location ? 'O2 B' + location.bank + 'S' + location.sensor + ' voltage'
        : 'O2 PID ' + hex2(pid) + ' voltage (location unverified)', locationVerified: !!location,
        bank: location?.bank ?? null, sensor: location?.sensor ?? null, layoutPid: location?.layoutPid ?? null };
    }
    const verified = state.sensorMask !== null && !state.supported.has(0x1D) &&
      !!(state.sensorMask & (1 << (pid - 0x14)));
    return { label: verified ? def.name : 'O2 sensor ' + (pid - 0x13) + ' voltage (location unverified)',
      locationVerified: verified };
  }
  return { label: def.name, locationVerified: null };
}

function recordReading(request, pid, reading) {
  recorder.record(request, { pid, ...recordingLabel(pid), unit: PIDS[pid].unit || '', ...reading });
}

function recordingDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  return Math.floor(seconds / 60) + 'm ' + String(seconds % 60).padStart(2, '0') + 's';
}

function renderRecording() {
  recorder.enforceLimit();
  renderPollingMode();
  renderCapabilities();
  const session = recorder.session;
  $('#btnRecordStart').disabled = recorder.active || !state.running || state.busy;
  $('#btnRecordStop').disabled = !recorder.active;
  const status = $('#recordingStatus');
  status.textContent = recorder.active ? 'Recording' : session ? 'Stopped' : 'Not recording';
  status.className = 'chip' + (recorder.active ? ' chip-crit' : '');
  const summary = recorder.summary();
  diagnosticGraphs.update(session, summary);
  diagnosticExports.update(session);
  if (!session) return;
  const reasons = { 'operator-stop': 'Stopped by operator', disconnected: 'Connection ended',
    reconnect: 'Connection replaced', 'adapter-probe': 'Adapter diagnosis started',
    'page-hidden': 'Page closed or reloaded', 'polling-error': 'Acquisition stopped after an error',
    'sample-limit': '20,000-result limit reached', 'duration-limit': '60-minute limit reached' };
  $('#recordingSummary').textContent = new Date(session.startedAt).toLocaleString() + ' · ' +
    recordingDuration(summary.durationMs) + ' · ' + summary.samples + ' results: ' +
    summary.valid + ' valid, ' + summary.missing + ' missing, ' + summary.failed + ' failed.' +
    (session.stopReason ? ' ' + (reasons[session.stopReason] || session.stopReason) + '.' : '');
  $('#recordingSource').textContent = session.source === 'demo'
    ? 'SIMULATED DATA — Demo adapter. This recording is not vehicle diagnostic evidence.'
    : 'Vehicle data — ' + (session.metadata.protocol || 'protocol not reported') +
      '. Sensor locations are unverified unless confirmed by the vehicle\'s sensor-location response.';
  const rows = $('#recordingQualityRows');
  rows.innerHTML = '';
  for (const series of summary.series) {
    const row = el('tr');
    for (const value of ['01 ' + hex2(series.pid) + ' · ' + series.label + (series.unit ? ' (' + series.unit + ')' : ''),
      series.valid, series.missing, series.failed,
      series.rateHz === null ? '—' : series.rateHz.toFixed(3),
      series.ageMs === null ? 'No valid reading' : (series.ageMs / 1000).toFixed(1) + ' s']) {
      row.appendChild(el('td', null, String(value)));
    }
    rows.appendChild(row);
  }
}

$('#btnRecordStart').addEventListener('click', () => {
  if (!state.running || state.busy || !state.connection || recorder.active) return;
  const previous = recorder.session;
  if (previous && !window.confirm('Start a new recording? This replaces the recording currently held in this tab.')) return;
  const notes = previous ? '' : $('#recordingNotes').value;
  recorder.start({ connectionId: state.connection.id, source: state.connection.source,
    notes, metadata: { ...state.vehicle, polling: pollingMetadata(), connectionStartedAt: state.connection.startedAt,
      supportedPids: [...state.supported].sort((a, b) => a - b),
      sensorLocationPid13: state.sensorMask,
      sensorLocationPid1D: state.alternativeMask, capabilities: state.capabilities?.snapshot() || null,
      measurements: [...state.supported].filter(pid => PIDS[pid]).map(pid =>
        ({ pid, ...recordingLabel(pid), unit: PIDS[pid].unit || '', static: !!PIDS[pid].static })) } });
  recorder.session.events.push({ type: 'sampling-mode', timestamp: recorder.session.startedAt, elapsedMs: 0,
    reason: recorder.session.metadata.polling.policy });
  $('#recordingNotes').value = notes;
  renderRecording();
});
$('#btnRecordStop').addEventListener('click', () => { recorder.stop(); renderRecording(); });
$('#recordingNotes').addEventListener('input', () => recorder.setNotes($('#recordingNotes').value));

function currentConnection(connection) {
  return !!connection && state.connection === connection && connection.client === elm;
}

function setConnectionBusy(busy) {
  state.busy = busy;
  ['btnConnect', 'btnDemo', 'btnProbe'].forEach(id => { $('#' + id).disabled = busy; });
  renderRecording();
}

function disconnectCurrent(reason = 'disconnected') {
  const connection = state.connection;
  if (!connection) return;
  // Invalidate before disconnecting: synchronous callbacks and late promises are harmless.
  onDisconnected(connection, reason);
  try { connection.transport.onDisconnect = null; connection.transport.disconnect(); } catch (e) {}
}

/* ---------------- logging ---------------- */
function log(kind, text) {
  const box = $('#termLog');
  box.appendChild(el('div', kind, (kind === 'tx' ? '> ' : '') + text));
  while (box.childNodes.length > 600) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

/* ---------------- theme & units ---------------- */
function applyTheme() {
  if (state.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = state.theme;
  $('#btnTheme').textContent = 'Theme: ' + state.theme;
  localStorage.setItem('theme', state.theme);
}
$('#btnTheme').addEventListener('click', () => {
  state.theme = { auto: 'dark', dark: 'light', light: 'auto' }[state.theme];
  applyTheme();
});

function unitsLabel() {
  $('#btnUnits').textContent = state.imperial ? 'km/h / °C' : 'mph / °F';
}
$('#btnUnits').addEventListener('click', () => {
  state.imperial = !state.imperial;
  localStorage.setItem('units', state.imperial ? 'imperial' : 'metric');
  unitsLabel();
  for (const [pid, v] of state.last) renderValue(pid, v);
});

function convert(def, v) {
  if (state.imperial && def.imp) return { v: def.imp.f(v), unit: def.imp.unit };
  return { v, unit: def.unit };
}
function fmtValue(def, v) {
  if (def.fmt) return def.fmt(Math.round(v));
  const c = convert(def, v);
  return c.v.toFixed(def.dec);
}

/* ---------------- gauges ---------------- */
function polar(cx, cy, r, deg) {
  const a = (deg - 90) * Math.PI / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function makeGauge(pid, max) {
  const def = PIDS[pid];
  const wrap = el('div', 'gauge');
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 180 122');
  const [sx, sy] = polar(90, 78, 62, -120), [ex, ey] = polar(90, 78, 62, 120);
  const d = `M ${sx} ${sy} A 62 62 0 1 1 ${ex} ${ey}`;
  const L = 2 * Math.PI * 62 * (240 / 360);
  for (const cls of ['g-track', 'g-fill']) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d); p.setAttribute('fill', 'none');
    p.setAttribute('stroke-width', '10'); p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('class', cls);
    if (cls === 'g-fill') p.setAttribute('stroke-dasharray', `0 ${L + 10}`);
    svg.appendChild(p);
  }
  const val = document.createElementNS(NS, 'text');
  val.setAttribute('x', '90'); val.setAttribute('y', '84');
  val.setAttribute('text-anchor', 'middle'); val.setAttribute('class', 'g-value');
  val.textContent = '—';
  const unit = document.createElementNS(NS, 'text');
  unit.setAttribute('x', '90'); unit.setAttribute('y', '102');
  unit.setAttribute('text-anchor', 'middle'); unit.setAttribute('class', 'g-unit');
  svg.appendChild(val); svg.appendChild(unit);
  wrap.appendChild(svg);
  wrap.appendChild(el('div', 'g-label', def.name));
  $('#gauges').appendChild(wrap);

  const min = def.min || 0;
  state.gauges.set(pid, {
    update(v) {
      const frac = Math.max(0, Math.min(1, (v - min) / (max - min)));
      svg.querySelector('.g-fill').setAttribute('stroke-dasharray', `${frac * L} ${L + 10}`);
      const c = convert(def, v);
      val.textContent = fmtValue(def, v);
      unit.textContent = c.unit;
    },
  });
}

/* ---------------- tiles ---------------- */
function makeTile(pid) {
  const def = PIDS[pid];
  const root = el('div', 'tile');
  const label = el('div', 'tile-label', recordingLabel(pid).label);
  root.appendChild(label);
  const value = el('div', 'tile-value' + (def.text ? ' tile-text' : ''), '—');
  let unitEl = null;
  if (!def.text) {
    unitEl = el('span', 'tile-unit', def.unit);
    value.appendChild(unitEl);
  }
  root.appendChild(value);
  let canvas = null, barEl = null;
  if (!def.text) {
    canvas = document.createElement('canvas');
    root.appendChild(canvas);
    const bar = el('div', 'tile-bar');
    barEl = el('i');
    bar.appendChild(barEl);
    root.appendChild(bar);
  }
  $('#tiles').appendChild(root);
  state.tiles.set(pid, { root, label, value, unitEl, canvas, barEl, def });
}

function renderValue(pid, v) {
  const t = state.tiles.get(pid);
  if (!t) return;
  const def = t.def;
  if (def.text) { t.value.textContent = v; return; }
  const c = convert(def, v);
  t.value.textContent = fmtValue(def, v);
  if (t.unitEl) { t.unitEl.textContent = def.fmt ? '' : c.unit; t.value.appendChild(t.unitEl); }
  if (t.barEl) {
    const frac = Math.max(0, Math.min(1, (v - def.min) / (def.max - def.min)));
    t.barEl.style.width = (frac * 100).toFixed(1) + '%';
  }
  const g = state.gauges.get(pid);
  if (g) g.update(v);
}

function pushSample(pid, v) {
  state.last.set(pid, v);
  let h = state.hist.get(pid);
  if (!h) { h = []; state.hist.set(pid, h); }
  h.push(v);
  if (h.length > 120) h.shift();
  renderValue(pid, v);
  drawSpark(pid);
}

function drawSpark(pid) {
  const t = state.tiles.get(pid);
  if (!t || !t.canvas) return;
  const h = state.hist.get(pid);
  if (!h || h.length < 2) return;
  const cv = t.canvas;
  if (!cv.width || cv.width < 10) {
    const r = cv.getBoundingClientRect();
    cv.width = Math.max(2 * (r.width || 140), 280); cv.height = 48;
  }
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  let lo = Math.min(...h), hi = Math.max(...h);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  h.forEach((v, i) => {
    const x = (i / (h.length - 1)) * (cv.width - 4) + 2;
    const y = cv.height - 4 - ((v - lo) / (hi - lo)) * (cv.height - 8);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}

/* ---------------- connection ---------------- */
function setChip(text, cls) {
  const c = $('#connChip');
  c.textContent = text;
  c.className = 'chip' + (cls ? ' ' + cls : '');
}
function showError(msg) {
  const b = $('#errBanner');
  b.textContent = msg;
  b.classList.remove('hidden');
  log('err', msg);
}

function resetUi() {
  $('#errBanner').classList.add('hidden');
  $('#gauges').innerHTML = ''; $('#tiles').innerHTML = '';
  $('#dtcList').innerHTML = ''; $('#dtcSummary').innerHTML = '';
  $('#readiness').innerHTML = ''; $('#vehicleInfo').innerHTML = '';
  $('#freezeWrap').classList.add('hidden');
  ['gauges', 'dtcSection', 'tilesSection', 'readinessSection', 'vehicleSection']
    .forEach(id => $('#' + id).classList.add('hidden'));
  state.tiles.clear(); state.hist.clear(); state.last.clear(); state.gauges.clear();
  state.supported = new Set(); state.sensorMask = null; state.vehicle = {};
  state.capabilities = null; state.alternativeMask = null;
  state.voltageAvailable = false;
  state.pollingMode = 'dashboard'; state.focusPlan = null; state.pollingRevision++;
  state.cycle = 0; state.slowIdx = 0; state.failures = 0;
  $('#milChip').classList.add('hidden');
  ['protoChip', 'voltChip', 'rateChip'].forEach(id => $('#' + id).classList.add('hidden'));
}

const tricorder = new Audio('assets/tricorder.mp3');
function playTricorder() {
  try { tricorder.currentTime = 0; tricorder.play().catch(() => {}); } catch (e) {}
}

async function connect(useDemo) {
  if (state.busy) return;
  if (!useDemo && !navigator.bluetooth) {
    $('#noBle').classList.remove('hidden');
    return;
  }
  setConnectionBusy(true);
  playTricorder();
  if (state.connection) {                // never orphan a live link — the adapter allows only one client
    disconnectCurrent('reconnect');
    await new Promise(r => setTimeout(r, 400));
  }
  resetUi();
  setChip('Connecting…');
  const nextTransport = useDemo ? new DemoTransport() : new BleTransport();
  const connection = { id: ++connectionSerial, transport: nextTransport, client: null,
    source: useDemo ? 'demo' : 'vehicle', startedAt: null };
  state.connection = connection;
  transport = nextTransport;
  try {
    await nextTransport.connect(m => log('sys', m));
  } catch (e) {
    state.connection = null;
    try { nextTransport.onDisconnect = null; nextTransport.disconnect(); } catch (ignored) {}
    transport = null;
    setChip('Disconnected');
    if (e.name !== 'NotFoundError') showError('Bluetooth: ' + e.message);
    setConnectionBusy(false);
    return;
  }
  connection.startedAt = new Date().toISOString();
  nextTransport.onDisconnect = () => onDisconnected(connection);
  connection.client = new Elm(nextTransport, log);
  elm = connection.client;
  const client = connection.client;
  $('#btnConnect').textContent = 'Disconnect';
  try {
    const ident = await client.init();
    if (!currentConnection(connection)) return;
    setChip(useDemo ? 'Demo' : 'Connected', 'chip-good');
    log('sys', 'Adapter: ' + ident);

    setChip('Reading ECU…', 'chip-good');
    const supported = await client.supportedPids();
    if (!currentConnection(connection)) return;
    if (!supported.size)
      throw new Error('The adapter connected but the ECU did not answer. Ignition on (position II) or engine running?');

    state.supported = supported;
    const proto = await client.protocol();
    if (!currentConnection(connection)) return;
    $('#protoChip').textContent = proto;
    $('#protoChip').classList.remove('hidden');
    const volts = await client.voltage();
    if (!currentConnection(connection)) return;
    if (volts) { state.voltageAvailable = true; $('#voltChip').textContent = volts.toFixed(1) + ' V'; $('#voltChip').classList.remove('hidden'); }

    buildDashboard(supported);
    setChip(useDemo ? 'Demo — live' : 'Live', 'chip-good');

    await readStatics(supported, connection);
    if (!currentConnection(connection)) return;
    await refreshVehicle(ident, proto, supported, connection);
    if (!currentConnection(connection)) return;
    await refreshDtcs(supported, connection);
    if (!currentConnection(connection)) return;

    state.running = true;
    pollLoop(connection);
  } catch (e) {
    if (!currentConnection(connection)) return;
    showError(e.message);
    setChip('Error', 'chip-crit');
  } finally {
    setConnectionBusy(false);
  }
}

function buildDashboard(supported) {
  state.capabilities = new EcuCapabilities(supported);
  const dynamic = [...supported].filter(p => PIDS[p] && !PIDS[p].static && p !== 0x01).sort((a, b) => a - b);
  state.fast = FAST_PIDS.filter(p => supported.has(p));
  state.slow = dynamic.filter(p => !state.fast.includes(p));

  for (const g of GAUGE_PIDS) if (supported.has(g.pid)) makeGauge(g.pid, g.max);
  if (state.gauges.size) $('#gauges').classList.remove('hidden');

  const shown = [...supported].filter(p => PIDS[p]).sort((a, b) => a - b);
  for (const pid of shown) makeTile(pid);
  $('#tileCount').textContent = shown.length + ' PIDs supported by this ECU';
  ['dtcSection', 'tilesSection', 'readinessSection', 'vehicleSection']
    .forEach(id => $('#' + id).classList.remove('hidden'));

  const unknown = [...supported].filter(p => !PIDS[p]);
  if (unknown.length)
    log('sys', 'ECU also advertises undecoded PIDs: ' + unknown.map(hex2).join(' '));
}

async function readStatics(supported, connection = state.connection) {
  for (const pid of [...supported].filter(p => PIDS[p] && PIDS[p].static)) {
    if (!currentConnection(connection)) return;
    const b = await connection.client.pid01(pid);
    if (!currentConnection(connection)) return;
    const reading = decodePidReading(pid, b);
    ensureCapabilities().observe(pid, reading, b, performance.now());
    if (reading.quality === 'valid') {
      if (pid === 0x13) state.sensorMask = b[0];
      if (pid === 0x1D) state.alternativeMask = b[0];
      pushSample(pid, reading.value);
    }
  }
  for (const [pid, tile] of state.tiles) if (tile.label) tile.label.textContent = recordingLabel(pid).label;
}

/* ---------------- polling ---------------- */
async function samplePid(pid, connection = state.connection) {
  if (!currentConnection(connection)) return;
  // Capture before queue submission. A recording started while this read is in
  // flight must not inherit it, even when the Bluetooth connection is unchanged.
  const request = recorder.captureRequest(connection.id);
  const focusPlan = activePollingPlan(), requestStarted = performance.now();
  const observe = quality => {
    if (focusPlan && state.focusPlan === focusPlan) {
      const now = performance.now(), duration = now - requestStarted;
      focusPlan.observe(pid, quality, now);
      if (!focusPlan.latency) focusPlan.latency = new Map();
      const latency = focusPlan.latency.get(pid) || { total: 0, count: 0, last: 0 };
      latency.total += duration; latency.count++; latency.last = duration; focusPlan.latency.set(pid, latency);
    }
  };
  let responseRecorded = false;
  try {
    const b = await connection.client.pid01(pid, 5000);
    if (!currentConnection(connection)) return;
    const reading = decodePidReading(pid, b);
    ensureCapabilities().observe(pid, reading, b, performance.now(), performance.now() - requestStarted);
    observe(reading.quality);
    recordReading(request, pid, reading);
    responseRecorded = true;
    if (reading.quality === 'valid') {
      state.failures = 0;
      const v = reading.value;
      if (PIDS[pid].text) { state.last.set(pid, v); renderValue(pid, v); }
      else pushSample(pid, v);
    } else if (++state.failures > 12) {
      throw new Error('The ECU stopped answering. Did the ignition turn off?');
    }
  } catch (e) {
    if (!currentConnection(connection)) return;
    if (!responseRecorded) {
      ensureCapabilities().observe(pid, { quality: 'failed', reason: e.message }, null, performance.now(), performance.now() - requestStarted);
      observe('failed');
      recordReading(request, pid, { quality: 'failed', value: null, reason: e.message });
    }
    state.running = false;
    recorder.stop('polling-error');
    showError(e.message);
    renderRecording();
  }
}

async function pollLoop(connection = state.connection) {
  const session = ++pollSession;
  const active = () => state.running && session === pollSession && currentConnection(connection);
  let queries = 0, t0 = performance.now();
  polling: while (active()) {
    const revision = state.pollingRevision;
    const focusPlan = activePollingPlan();
    if (focusPlan) {
      const batch = focusPlan.nextBatch(performance.now());
      const validation = focusPlan.nextValidation?.(performance.now()) ?? null;
      if (validation !== null && !batch.includes(validation)) batch.push(validation);
      if (!batch.length) {
        await new Promise(r => setTimeout(r, focusPlan.idleDelay(performance.now())));
        continue;
      }
      for (const pid of batch) {
        if (!active()) return;
        if (revision !== state.pollingRevision) continue polling;
        if (!focusPlan.eligible(pid, performance.now()) && !(pid === validation && focusPlan.canValidate(pid, performance.now()))) continue;
        await samplePid(pid, connection); queries++;
      }
    } else {
      // Preserve the original dashboard request order and slow rotation.
      for (const pid of state.fast) {
        if (!active()) return;
        if (revision !== state.pollingRevision) continue polling;
        await samplePid(pid, connection); queries++;
      }
      if (!active()) return;
      if (revision !== state.pollingRevision) continue polling;
      if (state.slow.length) {
        await samplePid(state.slow[state.slowIdx++ % state.slow.length], connection); queries++;
      }
    }
    if (!active()) return;
    if (revision !== state.pollingRevision) continue;
    if (++state.cycle % 10 === 0 && !(focusPlan instanceof ComparisonPollingPlan)) {
      const v = await connection.client.voltage().catch(() => null);
      if (!active()) return;
      if (v) { state.voltageAvailable = true; $('#voltChip').textContent = v.toFixed(1) + ' V'; $('#voltChip').classList.remove('hidden'); }
    }
    const now = performance.now();
    if (now - t0 > 2500) {
      $('#rateChip').textContent = (queries * 1000 / (now - t0)).toFixed(1) + ' PID/s';
      $('#rateChip').classList.remove('hidden');
      queries = 0; t0 = now;
    }
    await new Promise(r => setTimeout(r, 10));
  }
}

/* ---------------- DTCs ---------------- */
function dtcCard(code, pending) {
  const d = describeDtc(code);
  const card = el('div', 'dtc' + (pending ? ' dtc-pending' : ''));
  card.appendChild(el('span', 'dtc-code', code));
  card.appendChild(el('span', 'dtc-badge', pending ? 'pending' : 'stored'));
  card.appendChild(el('span', 'dtc-desc', d.desc || 'No generic description for this code'));
  const fam = el('div', 'dtc-family', d.family + '  ·  ');
  const a = el('a', null, 'look up ' + code);
  a.href = 'https://www.google.com/search?q=' + encodeURIComponent(code + ' OBD-II code Kia Sportage');
  a.target = '_blank'; a.rel = 'noopener';
  fam.appendChild(a);
  card.appendChild(fam);
  return card;
}

async function refreshDtcs(supported, connection = state.connection) {
  if (!currentConnection(connection)) return;
  const client = connection.client;
  const recordingRequest = recorder.captureRequest(connection.id);
  const list = $('#dtcList'), summary = $('#dtcSummary');
  list.innerHTML = ''; summary.innerHTML = '';
  $('#freezeWrap').classList.add('hidden');

  const st = supported.has(0x01) ? await client.status() : null;
  if (!currentConnection(connection)) return;
  const stored = await client.readDtcs(0x03);
  if (!currentConnection(connection)) return;
  const pending = await client.readDtcs(0x07);
  if (!currentConnection(connection)) return;
  if (st) ensureCapabilities().observe(0x01, { quality: 'valid' }, null, performance.now());
  // Piggyback only on this existing refresh; export never initiates ECU commands.
  captureRecordingTroubleCodes(recorder, recordingRequest, stored, pending);

  if (st) {
    $('#milChip').classList.toggle('hidden', !st.mil);
    summary.appendChild(el('span', 'chip ' + (st.mil ? 'chip-crit' : 'chip-good'),
      st.mil ? 'Check-engine light: ON' : 'Check-engine light: off'));
    renderReadiness(st.monitors);
  }
  summary.appendChild(el('span', 'chip' + (stored.length ? ' chip-crit' : ''), 'Stored: ' + stored.length));
  summary.appendChild(el('span', 'chip' + (pending.length ? ' chip-warn' : ''), 'Pending: ' + pending.length));

  if (!stored.length && !pending.length) {
    list.appendChild(el('div', 'dtc-none', 'No trouble codes — all clear.'));
  } else {
    for (const c of stored) list.appendChild(dtcCard(c, false));
    for (const c of pending) list.appendChild(dtcCard(c, true));
  }

  if (stored.length) await refreshFreeze(supported, connection);
}

async function refreshFreeze(supported, connection = state.connection) {
  if (!currentConnection(connection)) return;
  const client = connection.client;
  const rows = [];
  const dtcBytes = await client.freeze(0x02);
  if (!currentConnection(connection)) return;
  if (dtcBytes && dtcBytes.length >= 2) {
    const code = client._dtcFromBytes(dtcBytes[0], dtcBytes[1]);
    if (code) rows.push(['Code that froze the frame', code]);
  }
  for (const pid of FREEZE_PIDS.filter(p => supported.has(p))) {
    if (!currentConnection(connection)) return;
    const b = await client.freeze(pid);
    if (!currentConnection(connection)) return;
    const reading = decodePidReading(pid, b);
    if (reading.quality !== 'valid') continue;
    const def = PIDS[pid], v = reading.value;
    rows.push([def.name, def.text ? v : fmtValue(def, v) + ' ' + convert(def, v).unit]);
  }
  if (!rows.length) return;
  const t = $('#freezeTable');
  t.innerHTML = '';
  for (const [k, v] of rows) {
    t.appendChild(el('span', 'k', k));
    t.appendChild(el('span', 'v', v));
  }
  $('#freezeWrap').classList.remove('hidden');
}

function renderReadiness(monitors) {
  const box = $('#readiness');
  box.innerHTML = '';
  for (const m of monitors) {
    if (m.name === '(reserved)') continue;
    const cls = !m.avail ? 'rdy-na' : (m.done ? 'rdy-ok' : 'rdy-inc');
    const row = el('div', 'rdy ' + cls);
    row.appendChild(el('span', 'dot'));
    row.appendChild(el('span', null, m.name));
    row.appendChild(el('span', 'st', !m.avail ? 'not supported' : (m.done ? 'complete' : 'incomplete')));
    box.appendChild(row);
  }
}

/* ---------------- vehicle info ---------------- */
async function refreshVehicle(ident, proto, supported, connection = state.connection) {
  if (!currentConnection(connection)) return;
  const rows = [];
  const vin = await connection.client.readVin().catch(() => null);
  if (!currentConnection(connection)) return;
  state.vehicle = { vin, protocol: proto, adapter: ident,
    interface: connection.source === 'demo' ? 'Demo (simulated)' :
      (connection.transport.device && connection.transport.device.name) || 'BLE' };
  rows.push(['VIN', vin || 'not reported']);
  if (state.last.has(0x1C)) rows.push(['OBD standard', state.last.get(0x1C)]);
  if (state.last.has(0x51)) rows.push(['Fuel type', state.last.get(0x51)]);
  rows.push(['Protocol', proto]);
  rows.push(['Adapter', ident]);
  rows.push(['Interface', state.vehicle.interface]);
  const t = $('#vehicleInfo');
  t.innerHTML = '';
  for (const [k, v] of rows) {
    t.appendChild(el('span', 'k', k));
    t.appendChild(el('span', 'v', v));
  }
}

/* ---------------- adapter probe (diagnostic) ----------------
 * Dumps the real GATT layout, then brute-forces every notify+write pair,
 * write mode, and line ending until something answers ATZ. */

async function testPair(p, mode, eol) {
  const dec = new TextDecoder();
  let got = '';
  const onVal = ev => { got += dec.decode(ev.target.value); };
  try {
    await p.n.startNotifications();
    p.n.addEventListener('characteristicvaluechanged', onVal);
    const data = new TextEncoder().encode('ATZ' + eol);
    if (mode === 'nr') await p.w.writeValueWithoutResponse(data);
    else await p.w.writeValueWithResponse(data);
    await new Promise(r => setTimeout(r, 1800));
    return { ok: got.trim().length > 0, got: got.trim() };
  } catch (e) {
    return { ok: false, got: got.trim(), err: e.message };
  } finally {
    try { p.n.removeEventListener('characteristicvaluechanged', onVal); } catch (e) {}
    try { await p.n.stopNotifications(); } catch (e) {}
  }
}

const short = shortUuid;

async function probeAdapter() {
  if (!navigator.bluetooth) { showError('No Web Bluetooth in this browser.'); return; }
  disconnectCurrent('adapter-probe');
  $('#termDetails').open = true;
  log('sys', '=== adapter probe: pick the OBDII device again ===');

  let dev;
  try {
    dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
  } catch (e) { if (e.name !== 'NotFoundError') log('err', e.message); return; }
  log('sys', 'Device: ' + (dev.name || '(unnamed)'));

  let server;
  try { server = await gattConnect(dev, m => log('sys', m)); }
  catch (e) { log('err', e.message); return; }

  let services = [];
  try { services = await server.getPrimaryServices(); }
  catch (e) { log('err', 'getPrimaryServices: ' + e.message); }
  if (!services.length) {
    for (const u of BLE_SERVICES) { try { services.push(await server.getPrimaryService(u)); } catch (e) {} }
  }
  log('sys', 'visible services: ' + services.length);

  const pairs = [];
  for (const svc of services) {
    let chars = [];
    try { chars = await svc.getCharacteristics(); }
    catch (e) { log('err', 'service ' + short(svc.uuid) + ': ' + e.message); continue; }
    log('sys', 'service ' + short(svc.uuid));
    for (const c of chars) {
      const props = ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate']
        .filter(k => c.properties[k]).join(',') || 'none';
      log('sys', '    char ' + short(c.uuid) + '  [' + props + ']');
    }
    const ns = chars.filter(c => c.properties.notify || c.properties.indicate);
    const ws = chars.filter(c => c.properties.write || c.properties.writeWithoutResponse);
    for (const n of ns) for (const w of ws) pairs.push({ svc, n, w });
  }

  if (!pairs.length) {
    log('err', 'No notify+write pair found. The real UART service is probably hidden from the page — send Claude the service list above.');
    dev.gatt.disconnect();
    return;
  }

  log('sys', 'testing ' + pairs.length + ' candidate pair(s)…');
  let winner = null;
  for (const eol of ['\r', '\r\n']) {
    for (const p of pairs) {
      for (const mode of ['nr', 'r']) {
        if (mode === 'nr' && !p.w.properties.writeWithoutResponse) continue;
        if (mode === 'r' && !p.w.properties.write) continue;
        const tag = 'svc ' + short(p.svc.uuid) + ' w:' + short(p.w.uuid) + ' n:' + short(p.n.uuid) +
          ' ' + (mode === 'nr' ? 'writeNoResp' : 'write') + ' eol:' + (eol === '\r' ? 'CR' : 'CRLF');
        const res = await testPair(p, mode, eol);
        if (res.ok) {
          log('sys', '*** REPLY *** ' + tag + '  ->  ' + JSON.stringify(res.got));
          if (!winner) winner = { p, mode, eol };
        } else {
          log('sys', 'silent — ' + tag + (res.err ? '  (' + res.err + ')' : ''));
        }
      }
    }
    if (winner) break;
  }

  if (winner) {
    log('sys', '=== WORKING CHANNEL: service ' + short(winner.p.svc.uuid) +
      '  write ' + short(winner.p.w.uuid) + '  notify ' + short(winner.p.n.uuid) +
      '  mode ' + (winner.mode === 'nr' ? 'writeWithoutResponse' : 'write') +
      '  eol ' + (winner.eol === '\r' ? 'CR' : 'CRLF') + ' ===');
  } else {
    log('err', '=== nothing answered on any pair. Send Claude the service/char dump above. ===');
  }
  dev.gatt.disconnect();
}

/* ---------------- disconnect & buttons ---------------- */
function onDisconnected(connection = state.connection, reason = 'disconnected') {
  if (!connection || state.connection !== connection) return;
  state.running = false;
  pollSession++;
  recorder.endConnection(connection.id, reason);
  state.connection = null; transport = null; elm = null;
  setChip('Disconnected');
  $('#btnConnect').textContent = 'Connect';
  log('sys', 'Adapter disconnected.');
  renderRecording();
}

$('#btnConnect').addEventListener('click', () => {
  if (state.connection) {
    disconnectCurrent();
  } else {
    connect(false);
  }
});
$('#btnProbe').addEventListener('click', () => {
  if (state.busy) return;
  setConnectionBusy(true);
  probeAdapter().catch(e => log('err', 'probe: ' + e.message)).finally(() => setConnectionBusy(false));
});
$('#btnDemo').addEventListener('click', () => {
  connect(true);
});

$('#btnRefreshDtc').addEventListener('click', async () => {
  if (!elm) return;
  const connection = state.connection;
  const supported = new Set([...state.tiles.keys(), 0x01]);
  try { await refreshDtcs(supported, connection); }
  catch (e) { if (currentConnection(connection)) showError(e.message); }
});
$('#btnClearDtc').addEventListener('click', () => {
  if (!elm) return;
  $('#clearDlg').showModal();
});
$('#dlgCancel').addEventListener('click', () => $('#clearDlg').close());
$('#dlgConfirm').addEventListener('click', async () => {
  $('#clearDlg').close();
  const connection = state.connection;
  if (!currentConnection(connection)) return;
  try {
    const ok = await connection.client.clearDtcs();
    if (!currentConnection(connection)) return;
    log('sys', ok ? 'Codes cleared.' : 'Clear command not acknowledged.');
    const supported = new Set([...state.tiles.keys(), 0x01]);
    await refreshDtcs(supported, connection);
  } catch (e) { if (currentConnection(connection)) showError(e.message); }
});

$('#termForm').addEventListener('submit', ev => {
  ev.preventDefault();
  const v = $('#termInput').value.trim();
  if (!v) return;
  $('#termInput').value = '';
  if (!elm) { log('err', 'Not connected.'); return; }
  elm.cmd(v).catch(e => log('err', e.message));
});

/* Release the adapter on reload/close, or it keeps believing it has a client. */
window.addEventListener('pagehide', () => {
  disconnectCurrent('page-hidden');
});

/* ---------------- boot ---------------- */
applyTheme();
unitsLabel();
renderRecording();
// UI clock only. It never issues PID or adapter commands.
window.setInterval(renderRecording, 1000);
if (!navigator.bluetooth) $('#noBle').classList.remove('hidden');
log('sys', 'Ready. Connect to an ELM327 BLE adapter, or try Demo mode.');
