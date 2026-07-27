'use strict';

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let transport = null, elm = null, pollSession = 0;
const state = {
  running: false,
  fast: [], slow: [], slowIdx: 0, cycle: 0,
  tiles: new Map(),      // pid -> {root, valueEl, unitEl, canvas, barEl, def}
  hist: new Map(),       // pid -> number[]
  last: new Map(),       // pid -> raw value
  gauges: new Map(),     // pid -> {update}
  imperial: localStorage.getItem('units') === 'imperial',
  theme: localStorage.getItem('theme') || 'auto',
  failures: 0,
};

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
  root.appendChild(el('div', 'tile-label', def.name));
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
  state.tiles.set(pid, { root, value, unitEl, canvas, barEl, def });
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
  state.cycle = 0; state.slowIdx = 0; state.failures = 0;
  $('#milChip').classList.add('hidden');
  ['protoChip', 'voltChip', 'rateChip'].forEach(id => $('#' + id).classList.add('hidden'));
}

const tricorder = new Audio('assets/tricorder.mp3');
function playTricorder() {
  try { tricorder.currentTime = 0; tricorder.play().catch(() => {}); } catch (e) {}
}

async function connect(useDemo) {
  if (!useDemo && !navigator.bluetooth) {
    $('#noBle').classList.remove('hidden');
    return;
  }
  playTricorder();
  if (transport) {                       // never orphan a live link — the adapter allows only one client
    state.running = false;
    try { transport.onDisconnect = null; transport.disconnect(); } catch (e) {}
    transport = null; elm = null;
    await new Promise(r => setTimeout(r, 400));
  }
  resetUi();
  setChip('Connecting…');
  transport = useDemo ? new DemoTransport() : new BleTransport();
  try {
    await transport.connect(m => log('sys', m));
  } catch (e) {
    transport = null;
    setChip('Disconnected');
    if (e.name !== 'NotFoundError') showError('Bluetooth: ' + e.message);
    return;
  }
  transport.onDisconnect = onDisconnected;
  elm = new Elm(transport, log);
  $('#btnConnect').textContent = 'Disconnect';
  try {
    const ident = await elm.init();
    setChip(useDemo ? 'Demo' : 'Connected', 'chip-good');
    log('sys', 'Adapter: ' + ident);

    setChip('Reading ECU…', 'chip-good');
    const supported = await elm.supportedPids();
    if (!supported.size)
      throw new Error('The adapter connected but the ECU did not answer. Ignition on (position II) or engine running?');

    const proto = await elm.protocol();
    $('#protoChip').textContent = proto;
    $('#protoChip').classList.remove('hidden');
    const volts = await elm.voltage();
    if (volts) { $('#voltChip').textContent = volts.toFixed(1) + ' V'; $('#voltChip').classList.remove('hidden'); }

    buildDashboard(supported);
    setChip(useDemo ? 'Demo — live' : 'Live', 'chip-good');

    await readStatics(supported);
    await refreshVehicle(ident, proto, supported);
    await refreshDtcs(supported);

    state.running = true;
    pollLoop();
  } catch (e) {
    showError(e.message);
    setChip('Error', 'chip-crit');
  }
}

function buildDashboard(supported) {
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

async function readStatics(supported) {
  for (const pid of [...supported].filter(p => PIDS[p] && PIDS[p].static)) {
    const b = await elm.pid01(pid);
    if (b) pushSample(pid, PIDS[pid].decode(b));
  }
}

/* ---------------- polling ---------------- */
async function samplePid(pid) {
  try {
    const b = await elm.pid01(pid, 5000);
    if (b) {
      state.failures = 0;
      const v = PIDS[pid].decode(b);
      if (PIDS[pid].text) { state.last.set(pid, v); renderValue(pid, v); }
      else pushSample(pid, v);
    } else if (++state.failures > 12) {
      throw new Error('The ECU stopped answering. Did the ignition turn off?');
    }
  } catch (e) {
    state.running = false;
    showError(e.message);
  }
}

async function pollLoop() {
  const session = ++pollSession;
  let queries = 0, t0 = performance.now();
  while (state.running && session === pollSession) {
    for (const pid of state.fast) {
      if (!state.running || session !== pollSession) return;
      await samplePid(pid); queries++;
    }
    if (state.slow.length) {
      await samplePid(state.slow[state.slowIdx++ % state.slow.length]); queries++;
    }
    if (++state.cycle % 10 === 0) {
      const v = await elm.voltage().catch(() => null);
      if (v) $('#voltChip').textContent = v.toFixed(1) + ' V';
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

async function refreshDtcs(supported) {
  const list = $('#dtcList'), summary = $('#dtcSummary');
  list.innerHTML = ''; summary.innerHTML = '';
  $('#freezeWrap').classList.add('hidden');

  const st = supported.has(0x01) ? await elm.status() : null;
  const stored = await elm.readDtcs(0x03);
  const pending = await elm.readDtcs(0x07);

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

  if (stored.length) await refreshFreeze(supported);
}

async function refreshFreeze(supported) {
  const rows = [];
  const dtcBytes = await elm.freeze(0x02);
  if (dtcBytes && dtcBytes.length >= 2) {
    const code = elm._dtcFromBytes(dtcBytes[0], dtcBytes[1]);
    if (code) rows.push(['Code that froze the frame', code]);
  }
  for (const pid of FREEZE_PIDS.filter(p => supported.has(p))) {
    const b = await elm.freeze(pid);
    if (!b) continue;
    const def = PIDS[pid], v = def.decode(b);
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
async function refreshVehicle(ident, proto, supported) {
  const rows = [];
  const vin = await elm.readVin().catch(() => null);
  rows.push(['VIN', vin || 'not reported']);
  if (state.last.has(0x1C)) rows.push(['OBD standard', state.last.get(0x1C)]);
  if (state.last.has(0x51)) rows.push(['Fuel type', state.last.get(0x51)]);
  rows.push(['Protocol', proto]);
  rows.push(['Adapter', ident]);
  rows.push(['Interface', transport instanceof DemoTransport ? 'Demo (simulated)' :
    (transport.device && transport.device.name) || 'BLE']);
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
  if (transport) { state.running = false; transport.disconnect(); transport = null; elm = null; }
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
function onDisconnected() {
  state.running = false;
  setChip('Disconnected');
  $('#btnConnect').textContent = 'Connect';
  log('sys', 'Adapter disconnected.');
}

$('#btnConnect').addEventListener('click', () => {
  if (transport && (state.running || $('#btnConnect').textContent === 'Disconnect')) {
    state.running = false;
    transport.disconnect();
    transport = null; elm = null;
    onDisconnected();
  } else {
    connect(false);
  }
});
$('#btnProbe').addEventListener('click', () => {
  probeAdapter().catch(e => log('err', 'probe: ' + e.message));
});
$('#btnDemo').addEventListener('click', () => {
  if (transport) { state.running = false; transport.disconnect(); }
  connect(true);
});

$('#btnRefreshDtc').addEventListener('click', async () => {
  if (!elm) return;
  const supported = new Set([...state.tiles.keys(), 0x01]);
  await refreshDtcs(supported);
});
$('#btnClearDtc').addEventListener('click', () => {
  if (!elm) return;
  $('#clearDlg').showModal();
});
$('#dlgCancel').addEventListener('click', () => $('#clearDlg').close());
$('#dlgConfirm').addEventListener('click', async () => {
  $('#clearDlg').close();
  const ok = await elm.clearDtcs();
  log('sys', ok ? 'Codes cleared.' : 'Clear command not acknowledged.');
  const supported = new Set([...state.tiles.keys(), 0x01]);
  await refreshDtcs(supported);
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
  state.running = false;
  try { if (transport) { transport.onDisconnect = null; transport.disconnect(); } } catch (e) {}
});

/* ---------------- boot ---------------- */
applyTheme();
unitsLabel();
if (!navigator.bluetooth) $('#noBle').classList.remove('hidden');
log('sys', 'Ready. Connect to an ELM327 BLE adapter, or try Demo mode.');
