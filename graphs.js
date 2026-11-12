'use strict';

/* Read-only graph models and Canvas rendering. No adapter, queue, timer, or DOM
 * controls belong here. The same model/renderer can later be used by a report. */
const DIAGNOSTIC_GRAPH_SPECS = [
  { id: 'oxygen', title: 'Oxygen sensor voltage', axis: 'Voltage (V)', unit: 'V',
    baseline: [0, 1.275], pids: [0x14, 0x15] },
  { id: 'trims', title: 'Bank 1 fuel trims', axis: 'Fuel trim (%)', unit: '%',
    baseline: [-10, 10], pids: [0x06, 0x07] },
  { id: 'rpm', title: 'Engine speed', axis: 'Engine speed (rpm)', unit: 'rpm',
    baseline: [0, 1000], pids: [0x0C] },
  { id: 'load', title: 'Engine load and throttle', axis: 'Load / throttle (%)', unit: '%',
    baseline: [0, 100], pids: [0x04, 0x11] },
  { id: 'coolant', title: 'Coolant temperature', axis: 'Temperature (°C)', unit: '°C',
    baseline: [20, 110], pids: [0x05] },
];

const DIAGNOSTIC_GRAPH_PALETTE = {
  background: '#ffffff', text: '#171717', grid: '#d6d6d6',
  colors: ['#0064a5', '#ad3d00'],
};

function graphLowerBound(entries, time) {
  let lo = 0, hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid].sample.elapsedMs < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

class TelemetryGraphIndex {
  constructor() { this.session = null; this.cursor = 0; this.byPid = new Map(); this.invalidTimes = new Map(); }

  update(session) {
    if (this.session !== session || (session && session.samples.length < this.cursor)) {
      this.session = session; this.cursor = 0; this.byPid.clear(); this.invalidTimes.clear();
    }
    if (!session) return;
    // Keep references to original results, not resampled or duplicated histories.
    while (this.cursor < session.samples.length) {
      const order = this.cursor++, sample = session.samples[order];
      if (!Number.isFinite(sample.elapsedMs) || sample.elapsedMs < 0) {
        this.invalidTimes.set(sample.pid, (this.invalidTimes.get(sample.pid) || 0) + 1);
        continue;
      }
      let entries = this.byPid.get(sample.pid);
      if (!entries) { entries = []; this.byPid.set(sample.pid, entries); }
      const entry = { sample, order };
      if (!entries.length || entries[entries.length - 1].sample.elapsedMs <= sample.elapsedMs) entries.push(entry);
      else entries.splice(graphLowerBound(entries, sample.elapsedMs), 0, entry);
    }
  }
}

function diagnosticGraphRange(durationMs, mode = 'all', fromSeconds = 0, toSeconds = 0) {
  const duration = Math.max(0, Number.isFinite(durationMs) ? durationMs : 0);
  if (mode === 'custom') {
    if (!Number.isFinite(fromSeconds) || !Number.isFinite(toSeconds) || fromSeconds < 0 ||
        toSeconds <= fromSeconds || toSeconds * 1000 > duration) {
      return { error: 'Enter a start of 0 or later and an end after it, within the recording duration.' };
    }
    return { startMs: fromSeconds * 1000, endMs: toSeconds * 1000 };
  }
  const span = { '30': 30000, '60': 60000, '300': 300000 }[mode];
  // A one-second empty extent keeps a zero-duration / single-point plot legible.
  const endMs = Math.max(1000, duration);
  return { startMs: span ? Math.max(0, endMs - span) : 0, endMs };
}

function graphNumericQuality(sample, unit) {
  if (sample.quality === 'missing') return { quality: 'missing', reason: sample.reason };
  if (sample.quality !== 'valid') return { quality: 'failed', reason: sample.reason || 'Failed reading' };
  if (typeof sample.value !== 'number' || !Number.isFinite(sample.value)) {
    return { quality: 'failed', reason: 'Recorded value is not a finite number' };
  }
  if (sample.unit !== unit) return { quality: 'failed', reason: 'Recorded unit does not match this axis' };
  return { quality: 'valid', reason: null };
}

function graphYAxis(low, high) {
  if (low === high) { low -= 1; high += 1; }
  const rawStep = (high - low) / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const fraction = rawStep / magnitude;
  const step = [1, 2, 2.5, 5, 10].find(n => n >= fraction) * magnitude;
  const min = Math.floor(low / step) * step, max = Math.ceil(high / step) * step;
  const ticks = [];
  for (let i = 0; i <= Math.round((max - min) / step); i++) ticks.push(min + i * step);
  return { min, max, step, ticks };
}

function buildDiagnosticGraph(index, spec, range, durationMs) {
  const session = index.session, metadata = session ? session.metadata || {} : {};
  const supported = Array.isArray(metadata.supportedPids) ? new Set(metadata.supportedPids) : null;
  const series = spec.pids.map((pid, seriesIndex) => {
    const descriptor = (metadata.measurements || []).find(item => item.pid === pid);
    const all = index.byPid.get(pid) || [];
    const from = graphLowerBound(all, range.startMs);
    const selected = [];
    for (let i = from; i < all.length && all[i].sample.elapsedMs <= range.endMs; i++) {
      selected.push({ ...all[i], seriesIndex, ...graphNumericQuality(all[i].sample, spec.unit) });
    }
    const oxygen = pid === 0x14 || pid === 0x15;
    const verified = oxygen && descriptor?.locationVerified === true &&
      all.every(entry => entry.sample.locationVerified === true);
    const label = oxygen ? (verified
      ? (pid === 0x14 ? 'B1S1 · upstream' : 'B1S2 · downstream')
      : 'O2 PID ' + pid.toString(16).toUpperCase() + ' · location unverified')
      : ({ 6: 'Short-term trim B1', 7: 'Long-term trim B1', 12: 'Engine RPM',
        4: 'Engine load', 17: 'Throttle position', 5: 'Coolant temperature' }[pid]);
    const valid = selected.filter(entry => entry.quality === 'valid');
    let latest = null;
    for (let i = all.length - 1; i >= 0; i--) {
      if (graphNumericQuality(all[i].sample, spec.unit).quality === 'valid') { latest = all[i].sample; break; }
    }
    const validSpan = valid.length > 1 ? valid[valid.length - 1].sample.elapsedMs - valid[0].sample.elapsedMs : 0;
    let availability = selected.length ? 'Recorded results in this range'
      : all.length ? 'No results in this time range'
        : supported?.has(pid) ? 'Advertised by ECU; no recorded results yet'
          : supported ? 'Not advertised by this ECU' : 'PID support information unavailable';
    if (supported && !supported.has(pid) && all.length) availability = 'Recorded responses exist, but PID was not advertised';
    return { pid, label, verified, seriesIndex, entries: selected, valid: valid.length,
      missing: selected.filter(entry => entry.quality === 'missing').length,
      failed: selected.filter(entry => entry.quality === 'failed').length,
      invalidTimes: index.invalidTimes.get(pid) || 0,
      rateHz: validSpan > 0 ? (valid.length - 1) * 1000 / validSpan : null,
      ageMs: latest ? Math.max(0, durationMs - latest.elapsedMs) : null, availability };
  });
  let low = spec.baseline[0], high = spec.baseline[1];
  for (const item of series) for (const entry of item.entries) if (entry.quality === 'valid') {
    low = Math.min(low, entry.sample.value); high = Math.max(high, entry.sample.value);
  }
  const pad = (high - low) * 0.04;
  const yAxis = graphYAxis(low < 0 ? low - pad : low, high + pad);
  return { ...spec, range: { ...range }, durationMs, yAxis, series,
    source: session?.source || null, stopped: !!session?.endedAt,
    entries: series.flatMap(item => item.entries).sort((a, b) =>
      a.sample.elapsedMs - b.sample.elapsedMs || a.order - b.order) };
}

function diagnosticGraphLayout(width, height, model) {
  const left = width < 400 ? 55 : 65, right = 18, top = 48;
  const bottom = 66 + 12 * model.series.length;
  const plotWidth = Math.max(1, width - left - right), plotHeight = Math.max(1, height - top - bottom);
  return { left, top, plotWidth, plotHeight, width, height,
    x: time => left + (time - model.range.startMs) * plotWidth / (model.range.endMs - model.range.startMs),
    y: value => top + plotHeight - (value - model.yAxis.min) * plotHeight / (model.yAxis.max - model.yAxis.min),
    qualityY: seriesIndex => top + plotHeight + 19 + seriesIndex * 12 };
}

function diagnosticMarker(ctx, x, y, seriesIndex, quality, radius = 3.5) {
  if (quality === 'failed') {
    ctx.moveTo(x - radius, y - radius); ctx.lineTo(x + radius, y + radius);
    ctx.moveTo(x - radius, y + radius); ctx.lineTo(x + radius, y - radius);
  } else if (quality === 'missing' || seriesIndex === 0) {
    ctx.moveTo(x + radius, y); ctx.arc(x, y, radius, 0, Math.PI * 2);
  } else ctx.rect(x - radius, y - radius, radius * 2, radius * 2);
}

function renderDiagnosticCanvas(canvas, model, { width = 800, height = 280, pixelRatio = 1,
  palette = DIAGNOSTIC_GRAPH_PALETTE, selectedOrder = null } = {}) {
  const ratio = Math.max(1, Math.min(3, pixelRatio || 1));
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = palette.background; ctx.fillRect(0, 0, width, height);
  const layout = diagnosticGraphLayout(width, height, model);
  const { left, top, plotWidth, plotHeight } = layout;
  ctx.font = '12px system-ui, sans-serif'; ctx.lineWidth = 1;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = palette.text; ctx.textAlign = 'left'; ctx.fillText(model.axis, left, 15);
  if (model.source === 'demo') {
    ctx.textAlign = 'right'; ctx.fillText('SIMULATED DATA', width - 12, 31);
  }
  for (const value of model.yAxis.ticks) {
    const y = layout.y(value);
    ctx.strokeStyle = palette.grid; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + plotWidth, y); ctx.stroke();
    ctx.fillStyle = palette.text; ctx.textAlign = 'right';
    const decimals = Math.min(4, Math.max(0, Math.ceil(-Math.log10(model.yAxis.step)) + 1));
    ctx.fillText(String(Number(value.toFixed(decimals))), left - 8, y);
  }
  const intervals = Math.max(2, Math.min(6, Math.floor(plotWidth / 100)));
  const secondsPerTick = (model.range.endMs - model.range.startMs) / 1000 / intervals;
  const timeDecimals = Math.min(6, Math.max(0, Math.ceil(-Math.log10(secondsPerTick)) + 1));
  for (let i = 0; i <= intervals; i++) {
    const time = model.range.startMs + (model.range.endMs - model.range.startMs) * i / intervals;
    const x = layout.x(time);
    ctx.strokeStyle = palette.grid; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + plotHeight); ctx.stroke();
    ctx.fillStyle = palette.text;
    ctx.textAlign = i === 0 ? 'left' : i === intervals ? 'right' : 'center';
    ctx.fillText(String(Number((time / 1000).toFixed(timeDecimals))), x, height - 32);
  }
  ctx.textAlign = 'center'; ctx.fillText('Elapsed time (s)', left + plotWidth / 2, height - 10);
  if (!model.series.some(item => item.valid)) {
    ctx.fillText('No valid readings in this range', left + plotWidth / 2, top + plotHeight / 2, plotWidth - 8);
  }
  for (const series of model.series) {
    const color = palette.colors[series.seriesIndex % palette.colors.length];
    ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineWidth = 1.6;
    for (const quality of ['valid', 'missing', 'failed']) {
      ctx.beginPath();
      for (const entry of series.entries) if (entry.quality === quality) {
        diagnosticMarker(ctx, layout.x(entry.sample.elapsedMs), quality === 'valid'
          ? layout.y(entry.sample.value) : layout.qualityY(series.seriesIndex), series.seriesIndex, quality);
      }
      quality === 'valid' ? ctx.fill() : ctx.stroke();
    }
    ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'right';
    ctx.fillStyle = color;
    ctx.fillText(series.pid.toString(16).toUpperCase().padStart(2, '0') + ' gaps', left - 7, layout.qualityY(series.seriesIndex));
    ctx.font = '12px system-ui, sans-serif';
  }
  const selected = model.entries.find(entry => entry.order === selectedOrder);
  if (selected) {
    const x = layout.x(selected.sample.elapsedMs);
    const y = selected.quality === 'valid' ? layout.y(selected.sample.value) : layout.qualityY(selected.seriesIndex);
    ctx.strokeStyle = palette.text; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.stroke();
  }
  return layout;
}

function hitDiagnosticMeasurement(model, layout, x, y, radius = 14) {
  let closest = null, best = radius * radius;
  const time = model.range.startMs + (x - layout.left) *
    (model.range.endMs - model.range.startMs) / layout.plotWidth;
  const tolerance = radius * (model.range.endMs - model.range.startMs) / layout.plotWidth;
  for (const series of model.series) {
    const start = graphLowerBound(series.entries, time - tolerance);
    for (let i = start; i < series.entries.length && series.entries[i].sample.elapsedMs <= time + tolerance; i++) {
      const entry = series.entries[i];
      const dx = layout.x(entry.sample.elapsedMs) - x;
      const dy = (entry.quality === 'valid' ? layout.y(entry.sample.value) : layout.qualityY(series.seriesIndex)) - y;
      const distance = dx * dx + dy * dy;
      if (distance <= best) { best = distance; closest = entry; }
    }
  }
  return closest;
}
