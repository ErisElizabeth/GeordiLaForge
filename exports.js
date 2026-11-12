'use strict';

/* Export preparation has no access to dashboard state or adapter commands. */
function captureRecordingTroubleCodes(recorder, request, stored, pending) {
  const now = recorder.clock();
  recorder.enforceLimit(now);
  const session = recorder.session;
  if (!recorder.active || !request || request.recordingId !== session.id ||
      request.connectionId !== session.connectionId) return false;
  session.metadata.troubleCodes = {
    recordingId: session.id, connectionId: session.connectionId,
    requestedAt: request.requestedAt, requestElapsedMs: request.requestElapsedMs,
    capturedAt: new Date(now.wallMs).toISOString(), elapsedMs: Math.max(0, now.monoMs - session.startedMonoMs),
    stored: stored.slice(), pending: pending.slice(),
  };
  return true;
}

function diagnosticExportReady(session) {
  return !!session && typeof session.endedAt === 'string' && Number.isFinite(Date.parse(session.endedAt)) &&
    Number.isFinite(session.endedElapsedMs) && session.endedElapsedMs >= 0 &&
    Array.isArray(session.samples) && session.samples.length <= 20000;
}

function diagnosticExportText(value) { return value === null || value === undefined ? '' : String(value); }

function prepareDiagnosticExport(session, { omitIdentifiers = true, includeNotes = false } = {}) {
  if (!diagnosticExportReady(session)) throw new Error('Stop a complete diagnostic recording before exporting.');
  const copy = structuredClone(session), originalMetadata = copy.metadata || {};
  const knownIdentifiers = ['vin', 'vehicleId', 'vehicleName', 'licensePlate', 'registration', 'owner']
    .map(key => diagnosticExportText(originalMetadata[key])).filter(Boolean);
  const redact = value => {
    let text = diagnosticExportText(value);
    if (omitIdentifiers) {
      for (const identifier of knownIdentifiers) {
        const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(escaped, 'gi'), '[REDACTED]');
      }
      text = text.replace(/\b[A-HJ-NPR-Z0-9]{17}\b/gi, '[REDACTED VIN]');
    }
    return text;
  };
  const capture = originalMetadata.troubleCodes;
  const validCapture = capture && capture.recordingId === copy.id && capture.connectionId === copy.connectionId &&
    Number.isFinite(capture.elapsedMs) && capture.elapsedMs >= 0 && capture.elapsedMs <= copy.endedElapsedMs &&
    Number.isFinite(capture.requestElapsedMs) && capture.requestElapsedMs >= 0 && capture.requestElapsedMs <= capture.elapsedMs &&
    Array.isArray(capture.stored) && Array.isArray(capture.pending);
  // An allowlist prevents unrelated metadata or live dashboard fields entering an export.
  const metadata = {
    vin: omitIdentifiers ? null : diagnosticExportText(originalMetadata.vin) || null,
    vehicleName: omitIdentifiers ? null : diagnosticExportText(originalMetadata.vehicleName) || null,
    protocol: redact(originalMetadata.protocol) || null,
    connectionStartedAt: redact(originalMetadata.connectionStartedAt) || null,
    polling: originalMetadata.polling ? { mode: redact(originalMetadata.polling.mode),
      policy: redact(originalMetadata.polling.policy) } : null,
    supportedPids: Array.isArray(originalMetadata.supportedPids) ? originalMetadata.supportedPids.slice() : null,
    measurements: (originalMetadata.measurements || []).map(item => ({ pid: item.pid,
      label: redact(item.label), unit: redact(item.unit), locationVerified: item.locationVerified === true,
      static: item.static === true })),
    troubleCodes: validCapture ? { capturedAt: redact(capture.capturedAt), elapsedMs: capture.elapsedMs,
      stored: capture.stored.map(redact), pending: capture.pending.map(redact) } : null,
  };
  return {
    id: redact(copy.id), connectionId: redact(copy.connectionId),
    source: ['demo', 'vehicle'].includes(copy.source) ? copy.source : 'unknown',
    startedAt: redact(copy.startedAt), endedAt: redact(copy.endedAt), endedElapsedMs: copy.endedElapsedMs,
    stopReason: redact(copy.stopReason), timingBasis: redact(copy.timingBasis), metadata,
    notes: includeNotes ? redact(copy.notes) : null,
    privacy: { omitIdentifiers: !!omitIdentifiers, includeNotes: !!includeNotes },
    samples: copy.samples.map(sample => ({
      mode: redact(sample.mode), pid: sample.pid, pidHex: redact(sample.pidHex), label: redact(sample.label),
      unit: redact(sample.unit), locationVerified: sample.locationVerified,
      timestamp: redact(sample.timestamp), elapsedMs: sample.elapsedMs,
      requestedAt: redact(sample.requestedAt), requestElapsedMs: sample.requestElapsedMs, responseMs: sample.responseMs,
      quality: redact(sample.quality), reason: sample.reason === null ? null : redact(sample.reason),
      value: typeof sample.value === 'string' ? redact(sample.value) : sample.value,
    })),
    events: (copy.events || []).map(event => ({ type: redact(event.type), timestamp: redact(event.timestamp),
      elapsedMs: event.elapsedMs, reason: redact(event.reason) })),
  };
}

function diagnosticSourceNotice(source) {
  return source === 'demo' ? 'SIMULATED DATA - NOT VEHICLE DIAGNOSTIC EVIDENCE'
    : source === 'vehicle' ? 'VEHICLE RECORDING - OBSERVED MEASUREMENTS'
      : 'SOURCE UNVERIFIED - NOT VERIFIED VEHICLE EVIDENCE';
}

function diagnosticCsvCell(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  let text = diagnosticExportText(value);
  // RFC 4180 quoting alone does not prevent spreadsheet evaluation. Preserve
  // real numeric negatives while neutralizing formula-like text and controls.
  if (/^[\t\r\n]/.test(text) || /^[\s\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]*[=+\-@]/u.test(text)) {
    text = "'" + text;
  }
  return '"' + text.replace(/"/g, '""') + '"';
}

function diagnosticCsv(exported) {
  const headers = ['row_type', 'recording_id', 'data_source', 'source_notice', 'connection_id',
    'recording_started_at', 'recording_ended_at', 'recording_duration_ms', 'stop_reason', 'vin',
    'recording_notes', 'timestamp', 'elapsed_ms', 'mode', 'pid_hex', 'measurement', 'value',
    'native_unit', 'quality', 'failure_explanation', 'sensor_location_verified', 'request_queued_at',
    'request_elapsed_ms', 'response_including_queue_ms', 'polling_mode', 'polling_policy'];
  const common = [exported.id, exported.source, diagnosticSourceNotice(exported.source), exported.connectionId,
    exported.startedAt, exported.endedAt, exported.endedElapsedMs, exported.stopReason, exported.metadata.vin];
  const polling = [exported.metadata.polling?.mode, exported.metadata.polling?.policy];
  const rows = [headers, ['recording', ...common, exported.notes, '', '', '', '', '', '', '', '', '', '', '', '', '', ...polling]];
  for (const sample of exported.samples) rows.push(['sample', ...common, '', sample.timestamp, sample.elapsedMs,
    sample.mode, sample.pidHex, sample.label, sample.value, sample.unit, sample.quality, sample.reason,
    sample.locationVerified === null || sample.locationVerified === undefined ? '' : String(sample.locationVerified),
    sample.requestedAt, sample.requestElapsedMs, sample.responseMs, ...polling]);
  return '\ufeff' + rows.map(row => row.map(diagnosticCsvCell).join(',')).join('\r\n') + '\r\n';
}

function diagnosticExportFilename(exported, extension) {
  const source = exported.source === 'demo' ? 'simulated' : exported.source === 'vehicle' ? 'vehicle' : 'unverified';
  const stamp = exported.startedAt.replace(/[^0-9TZ]/g, '').slice(0, 16) || 'undated';
  return 'geordi-' + source + '-' + stamp + '.' + extension;
}

function diagnosticExportStatistics(exported) {
  const byPid = new Map(), counts = { valid: 0, missing: 0, failed: 0, other: 0 };
  for (const sample of exported.samples) {
    const quality = ['valid', 'missing', 'failed'].includes(sample.quality) ? sample.quality : 'other';
    counts[quality]++;
    let stats = byPid.get(sample.pid);
    if (!stats) { stats = { pid: sample.pid, label: sample.label, unit: sample.unit,
      valid: 0, missing: 0, failed: 0, other: 0, times: [], numeric: [] }; byPid.set(sample.pid, stats); }
    stats[quality]++;
    if (quality === 'valid') {
      if (Number.isFinite(sample.elapsedMs)) stats.times.push(sample.elapsedMs);
      if (typeof sample.value === 'number' && Number.isFinite(sample.value)) stats.numeric.push(sample.value);
    }
  }
  return { counts, series: [...byPid.values()].sort((a, b) => a.pid - b.pid).map(stats => {
    const times = stats.times.slice().sort((a, b) => a - b);
    return { pid: stats.pid, label: stats.label, unit: stats.unit, valid: stats.valid, missing: stats.missing,
      failed: stats.failed, other: stats.other,
      rateHz: times.length > 1 && times.at(-1) > times[0] ? (times.length - 1) * 1000 / (times.at(-1) - times[0]) : null,
      min: stats.numeric.length ? Math.min(...stats.numeric) : null,
      max: stats.numeric.length ? Math.max(...stats.numeric) : null };
  }) };
}
