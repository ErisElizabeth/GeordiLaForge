'use strict';

/* Graph controls consume the recording only. update() is driven by the existing
 * recording UI clock, never by a second acquisition loop. */
class DiagnosticGraphs {
  constructor() {
    this.index = new TelemetryGraphIndex();
    this.session = null; this.summary = null; this.range = null; this.renderKey = null;
    this.customRange = null; this.rangeError = '';
    this.$ = id => document.querySelector('#' + id);
    this.views = DIAGNOSTIC_GRAPH_SPECS.map(spec => ({ spec,
      canvas: this.$('graph-' + spec.id), legend: this.$('legend-' + spec.id),
      inspection: this.$('inspect-' + spec.id), previous: this.$('previous-' + spec.id),
      next: this.$('next-' + spec.id), selectedOrder: null, model: null, layout: null }));
    this.$('graphRange').addEventListener('change', () => {
      const custom = this.$('graphRange').value === 'custom';
      this.$('graphCustom').hidden = !custom;
      if (custom && this.summary) {
        this.$('graphFrom').value = '0';
        this.$('graphTo').value = String(Math.floor(this.summary.durationMs) / 1000);
      }
      this.rangeError = '';
      if (custom) this.applyRange();
      else this.refresh();
    });
    this.$('graphApplyRange').addEventListener('click', () => this.applyRange());
    this.$('graphDetails').addEventListener('toggle', () => this.refresh());
    for (const view of this.views) {
      view.previous.addEventListener('click', () => this.step(view, -1));
      view.next.addEventListener('click', () => this.step(view, 1));
      view.canvas.addEventListener('click', event => {
        if (!view.model || !view.layout) return;
        const rect = view.canvas.getBoundingClientRect();
        const entry = hitDiagnosticMeasurement(view.model, view.layout,
          (event.clientX - rect.left) * view.layout.width / rect.width,
          (event.clientY - rect.top) * view.layout.height / rect.height);
        if (entry) this.select(view, entry.order);
        else {
          view.selectedOrder = null;
          view.inspection.textContent = 'No recorded measurement near that position. Use Previous / Next to inspect every result.';
          this.draw(view); this.updateButtons(view);
        }
      });
      view.canvas.addEventListener('keydown', event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault(); this.step(view, event.key === 'ArrowLeft' ? -1 : 1);
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          const entries = view.model?.entries || [];
          if (entries.length) this.select(view, entries[event.key === 'Home' ? 0 : entries.length - 1].order);
        }
      });
    }
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => this.refresh());
      for (const view of this.views) this.resizeObserver.observe(view.canvas);
    }
    window.addEventListener('resize', () => this.refresh());
  }

  palette() {
    const style = getComputedStyle(document.documentElement);
    const value = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    return { background: value('--graph-bg', '#ffffff'), text: value('--ink', '#171717'),
      grid: value('--graph-grid', '#d6d6d6'),
      colors: [value('--graph-blue', '#0064a5'), value('--graph-orange', '#ad3d00')] };
  }

  refresh() { this.renderKey = null; this.update(this.session, this.summary); }

  applyRange() {
    if (!this.summary) return;
    const from = this.$('graphFrom').value.trim(), to = this.$('graphTo').value.trim();
    const range = diagnosticGraphRange(this.summary.durationMs, 'custom',
      from === '' ? NaN : Number(from), to === '' ? NaN : Number(to));
    this.rangeError = range.error || '';
    if (!range.error) this.customRange = range;
    this.refresh();
  }

  update(session, summary) {
    const replaced = this.session !== session;
    this.session = session; this.summary = summary;
    this.index.update(session);
    this.$('graphContent').hidden = !session;
    this.$('graphEmpty').hidden = !!session;
    this.$('graphRange').disabled = !session;
    if (!session || !summary) {
      this.renderKey = null;
      for (const view of this.views) { view.model = null; view.layout = null; view.selectedOrder = null; }
      return;
    }
    if (replaced) {
      this.renderKey = null;
      this.range = null; this.customRange = null; this.rangeError = '';
      if (this.$('graphRange').value === 'custom') this.$('graphRange').value = 'all';
      this.$('graphCustom').hidden = this.$('graphRange').value !== 'custom';
      for (const view of this.views) view.selectedOrder = null;
    }
    const custom = this.$('graphRange').value === 'custom';
    const nextRange = custom ? this.customRange : diagnosticGraphRange(summary.durationMs, this.$('graphRange').value || 'all');
    this.$('graphRangeError').textContent = this.rangeError;
    if (nextRange) this.range = nextRange;
    if (!this.range) this.range = diagnosticGraphRange(summary.durationMs);
    this.$('graphWindow').textContent = 'Displayed window: ' + (this.range.startMs / 1000).toFixed(3) +
      '–' + (this.range.endMs / 1000).toFixed(3) + ' s since recording start.' +
      (this.rangeError ? ' Previous valid window retained.' : '') +
      (custom ? '' : ' The newest time follows the recording while active.');
    this.$('graphSource').textContent = session.source === 'demo'
      ? 'SIMULATED DATA — Demo recording; not vehicle diagnostic evidence.'
      : 'Vehicle recording — observed measurements only; no automatic fault conclusions.';
    if (this.$('graphDetails').open === false) return;
    const palette = this.palette();
    const key = [session.id, session.samples.length, session.endedAt, Math.floor(summary.durationMs / 1000),
      this.range.startMs, this.range.endMs, JSON.stringify(palette)].join('|');
    if (key === this.renderKey) return;
    this.renderKey = key;
    for (const view of this.views) {
      view.model = buildDiagnosticGraph(this.index, view.spec, this.range, summary.durationMs);
      this.renderLegend(view, palette);
      const selected = view.model.entries.find(entry => entry.order === view.selectedOrder);
      if (selected) this.describe(view, selected);
      else {
        view.selectedOrder = null;
        view.inspection.textContent = view.model.entries.length
          ? 'Select a marker, or use Previous / Next or the canvas arrow keys to inspect actual results.'
          : 'No recorded results to inspect in this range.';
      }
      this.draw(view, palette); this.updateButtons(view);
    }
  }

  renderLegend(view, palette) {
    view.legend.innerHTML = '';
    for (const series of view.model.series) {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'graph-series-name';
      const marker = document.createElement('span');
      marker.className = 'graph-swatch ' + (series.seriesIndex ? 'graph-square' : 'graph-circle');
      marker.style.backgroundColor = palette.colors[series.seriesIndex];
      marker.setAttribute('aria-hidden', 'true');
      name.appendChild(marker);
      name.appendChild(document.createTextNode(series.label + ' · ' + view.spec.unit +
        ' · PID ' + series.pid.toString(16).toUpperCase().padStart(2, '0')));
      item.appendChild(name);
      const status = document.createElement('span'); status.className = 'graph-series-quality';
      status.textContent = series.availability + '. Window: ' + series.valid + ' valid, ' + series.missing +
        ' missing, ' + series.failed + ' failed/unplottable. Valid rate: ' +
        (series.rateHz === null ? 'unavailable (need 2 readings)' : series.rateHz.toFixed(3) + ' Hz') +
        '. Latest valid age in recording: ' + (series.ageMs === null ? 'unavailable' :
          (series.ageMs / 1000).toFixed(1) + ' s' + (view.model.stopped ? ' at stop' : '')) + '.' +
        (series.invalidTimes ? ' ' + series.invalidTimes + ' results have invalid elapsed times and cannot be plotted.' : '');
      item.appendChild(status); view.legend.appendChild(item);
    }
  }

  draw(view, palette = this.palette()) {
    if (!view.model) return;
    const width = view.canvas.getBoundingClientRect().width;
    if (width < 1) return;
    view.layout = renderDiagnosticCanvas(view.canvas, view.model, {
      width, height: 280, pixelRatio: window.devicePixelRatio || 1, palette,
      selectedOrder: view.selectedOrder });
  }

  updateButtons(view) {
    const entries = view.model?.entries || [];
    const position = entries.findIndex(entry => entry.order === view.selectedOrder);
    view.previous.disabled = !entries.length || position === 0;
    view.next.disabled = !entries.length || position === entries.length - 1;
  }

  step(view, direction) {
    const entries = view.model?.entries || [];
    if (!entries.length) return;
    const position = entries.findIndex(entry => entry.order === view.selectedOrder);
    const next = position < 0 ? (direction > 0 ? 0 : entries.length - 1)
      : Math.max(0, Math.min(entries.length - 1, position + direction));
    this.select(view, entries[next].order);
  }

  select(view, order) {
    const entry = view.model?.entries.find(item => item.order === order);
    if (!entry) return;
    view.selectedOrder = order; this.describe(view, entry); this.draw(view); this.updateButtons(view);
  }

  describe(view, entry) {
    const sample = entry.sample, series = view.model.series[entry.seriesIndex];
    const position = view.model.entries.findIndex(item => item.order === entry.order) + 1;
    const value = sample.value === null ? 'no value' : String(sample.value) + ' ' + sample.unit;
    view.inspection.textContent = position + ' / ' + view.model.entries.length + ' · ' + series.label +
      ' · Mode ' + sample.mode + ' PID ' + sample.pidHex + ' · ' + sample.elapsedMs.toFixed(3) +
      ' ms elapsed · ' + sample.timestamp + ' · ' + value + ' · recorded quality: ' + sample.quality +
      (sample.reason ? ' (' + sample.reason + ')' : '') +
      (entry.quality !== sample.quality ? ' · Unplottable: ' + entry.reason : '') +
      ' · request queued: ' + sample.requestedAt + ' · response including queue wait: ' +
      sample.responseMs.toFixed(3) + ' ms.';
  }
}
