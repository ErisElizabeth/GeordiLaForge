'use strict';

/* Passive recording only: this module never talks to the adapter or schedules reads.
 * Timestamps describe submission to the command queue and receipt in the browser,
 * not the ECU's internal measurement time. Native units are retained unchanged. */
class TelemetryRecorder {
  constructor({ maxSamples = 20000, maxDurationMs = 60 * 60 * 1000,
    clock = () => ({ wallMs: Date.now(), monoMs: performance.now() }) } = {}) {
    if (!Number.isInteger(maxSamples) || maxSamples < 1 ||
        !Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
      throw new Error('Recording limits must be positive.');
    }
    this.maxSamples = maxSamples;
    this.maxDurationMs = maxDurationMs;
    this.clock = clock;
    this.session = null;
    this._serial = 0;
  }

  get active() { return !!this.session && this.session.endedAt === null; }

  start({ connectionId, source, metadata = {}, notes = '' }) {
    if (this.active) throw new Error('Stop the current recording first.');
    if (connectionId === null || connectionId === undefined || !['vehicle', 'demo'].includes(source)) {
      throw new Error('A recording needs a connection and an explicit data source.');
    }
    const now = this.clock();
    this.session = {
      schemaVersion: 1, id: 'recording-' + (++this._serial), connectionId, source,
      startedAt: new Date(now.wallMs).toISOString(), endedAt: null,
      startedMonoMs: now.monoMs, endedElapsedMs: null, stopReason: null,
      limits: { maxSamples: this.maxSamples, maxDurationMs: this.maxDurationMs },
      timingBasis: 'Browser queue submission and response receipt; response time includes queue wait.',
      metadata: structuredClone(metadata), notes: '', samples: [], events: [],
      counts: { valid: 0, missing: 0, failed: 0 }, byPid: {},
    };
    this.setNotes(notes);
    this._event('recording-start', now);
    return this.session;
  }

  setNotes(notes) {
    if (this.session) this.session.notes = String(notes).slice(0, 4000);
  }

  _elapsed(now) { return Math.max(0, now.monoMs - this.session.startedMonoMs); }

  _event(type, now, reason = null) {
    this.session.events.push({ type, timestamp: new Date(now.wallMs).toISOString(),
      elapsedMs: this._elapsed(now), connectionId: this.session.connectionId, reason });
  }

  stop(reason = 'operator-stop', now = this.clock()) {
    if (!this.active) return false;
    this.session.endedAt = new Date(now.wallMs).toISOString();
    this.session.endedElapsedMs = this._elapsed(now);
    this.session.stopReason = reason;
    this._event('recording-stop', now, reason);
    return true;
  }

  endConnection(connectionId, reason = 'disconnected') {
    if (!this.active || this.session.connectionId !== connectionId) return false;
    const now = this.clock();
    this._event('connection-end', now, reason);
    return this.stop(reason, now);
  }

  enforceLimit(now = this.clock()) {
    if (this.active && this._elapsed(now) >= this.maxDurationMs) this.stop('duration-limit', now);
  }

  captureRequest(connectionId) {
    const now = this.clock();
    this.enforceLimit(now);
    if (!this.active || this.session.connectionId !== connectionId) return null;
    return { recordingId: this.session.id, connectionId,
      requestedAt: new Date(now.wallMs).toISOString(),
      requestElapsedMs: this._elapsed(now), monoMs: now.monoMs };
  }

  record(request, { pid, label, unit = '', quality, value = null, reason = null,
    locationVerified = null }) {
    const now = this.clock();
    this.enforceLimit(now);
    if (!this.active || !request || request.recordingId !== this.session.id ||
        request.connectionId !== this.session.connectionId) return false;
    if (!Number.isInteger(pid) || pid < 0 || pid > 255) throw new Error('Invalid PID.');
    if (!['valid', 'missing', 'failed'].includes(quality)) throw new Error('Invalid sample quality.');
    if (quality === 'valid' && !(typeof value === 'number' && Number.isFinite(value)) &&
        !(typeof value === 'string' && value.length > 0 && value.length <= 256)) {
      quality = 'failed'; reason = 'Invalid decoded value';
    }
    const sample = {
      mode: '01', pid, pidHex: pid.toString(16).toUpperCase().padStart(2, '0'),
      label: String(label).slice(0, 120), unit: String(unit).slice(0, 24), locationVerified,
      timestamp: new Date(now.wallMs).toISOString(), elapsedMs: this._elapsed(now),
      requestedAt: request.requestedAt, requestElapsedMs: request.requestElapsedMs,
      responseMs: Math.max(0, now.monoMs - request.monoMs),
      quality, value: quality === 'valid' ? value : null,
      reason: reason === null ? null : String(reason).slice(0, 240),
    };
    const session = this.session;
    session.samples.push(sample);
    session.counts[quality]++;
    let stats = session.byPid[pid];
    if (!stats) stats = session.byPid[pid] = { pid, label: sample.label, unit: sample.unit,
      attempts: 0, valid: 0, missing: 0, failed: 0, firstValidElapsedMs: null,
      lastValidElapsedMs: null, lastAttemptElapsedMs: null, lastQuality: null,
      minIntervalMs: null, maxIntervalMs: null };
    stats.attempts++; stats[quality]++;
    stats.lastAttemptElapsedMs = sample.elapsedMs;
    stats.lastQuality = quality;
    if (quality === 'valid') {
      if (stats.lastValidElapsedMs !== null) {
        const interval = sample.elapsedMs - stats.lastValidElapsedMs;
        stats.minIntervalMs = stats.minIntervalMs === null ? interval : Math.min(stats.minIntervalMs, interval);
        stats.maxIntervalMs = stats.maxIntervalMs === null ? interval : Math.max(stats.maxIntervalMs, interval);
      }
      if (stats.firstValidElapsedMs === null) stats.firstValidElapsedMs = sample.elapsedMs;
      stats.lastValidElapsedMs = sample.elapsedMs;
    }
    if (session.samples.length >= this.maxSamples) this.stop('sample-limit', now);
    return true;
  }

  summary() {
    const session = this.session;
    if (!session) return null;
    const durationMs = this.active ? this._elapsed(this.clock()) : session.endedElapsedMs;
    const series = Object.values(session.byPid).map(stats => {
      const span = stats.lastValidElapsedMs - stats.firstValidElapsedMs;
      return { ...stats, rateHz: stats.valid >= 2 && span > 0 ? (stats.valid - 1) * 1000 / span : null,
        ageMs: stats.lastValidElapsedMs === null ? null : Math.max(0, durationMs - stats.lastValidElapsedMs) };
    }).sort((a, b) => a.pid - b.pid);
    return { durationMs, samples: session.samples.length, ...session.counts, series };
  }
}
