'use strict';

/* Passive connection inventory. No adapter requests originate here. */
function oxygenLocation(pid, supported, masks = {}) {
  if (pid < 0x14 || pid > 0x1B || !supported.has(pid)) return null;
  const two = supported.has(0x13), four = supported.has(0x1D);
  if (two === four) return null; // Conflicting or absent layout advertisements.
  const layoutPid = two ? 0x13 : 0x1D, mask = masks[layoutPid];
  const bit = pid - 0x14;
  if (!Number.isInteger(mask) || !(mask & (1 << bit))) return null;
  const perBank = two ? 4 : 2;
  return { bank: Math.floor(bit / perBank) + 1, sensor: bit % perBank + 1, layoutPid };
}

class EcuCapabilities {
  constructor(supported, definitions = PIDS) {
    this.supported = new Set(supported); this.definitions = definitions;
    this.masks = {}; this.results = new Map(); this.revision = 0;
  }

  observe(pid, reading, bytes = null, now = null, responseMs = null) {
    if (!this.supported.has(pid)) return;
    const previous = this.results.get(pid);
    this.results.set(pid, { decodedSuccessfully: previous?.decodedSuccessfully === true || reading.quality === 'valid',
      lastQuality: reading.quality, reason: reading.reason || null, lastAt: now,
      responseMs: Number.isFinite(responseMs) ? responseMs : null });
    if ((pid === 0x13 || pid === 0x1D) && reading.quality === 'valid' && bytes) this.masks[pid] = bytes[0];
    this.revision++;
  }

  success(pid) { return this.results.get(pid)?.decodedSuccessfully === true; }
  location(pid) { return oxygenLocation(pid, this.supported, this.masks); }
  name(pid) {
    if (pid >= 0x14 && pid <= 0x1B) {
      const location = this.location(pid);
      return location ? 'O2 B' + location.bank + 'S' + location.sensor + ' voltage'
        : 'O2 PID ' + pid.toString(16).toUpperCase() + ' voltage (location unverified)';
    }
    return this.definitions[pid]?.name || (pid === 0x01 ? 'MIL / readiness (session decoder)' : 'Undecoded PID');
  }

  classify(pid) {
    const advertised = this.supported.has(pid), decoded = !!this.definitions[pid] || pid === 0x01;
    const observed = this.results.get(pid), location = this.location(pid);
    return { pid, label: this.name(pid), advertised, decoded,
      classification: !advertised ? 'Not advertised by ECU' : decoded ? 'Supported and decoded' : 'Supported; decoder unavailable',
      decodedSuccessfully: !!observed?.decodedSuccessfully, lastQuality: observed?.lastQuality || null,
      reason: observed?.reason || null, responseMs: observed?.responseMs ?? null,
      location: location || null,
      suitability: !advertised ? 'Not advertised' : !decoded ? 'Decoder unavailable'
        : pid >= 0x14 && pid <= 0x1B && !location ? 'O2 location unverified'
          : !this.definitions[pid] || this.definitions[pid].static ? 'Static / session information'
            : !observed?.decodedSuccessfully ? 'Awaiting a successful decoded response' : 'Validated live channel' };
  }

  rows(includeReferences = false) {
    const pids = new Set(this.supported);
    if (includeReferences) { Object.keys(this.definitions).forEach(pid => pids.add(Number(pid))); pids.add(0x01); }
    return [...pids].sort((a, b) => a - b).map(pid => this.classify(pid));
  }

  snapshot() { return this.rows(true).map(row => ({ ...row, location: row.location ? { ...row.location } : null })); }
}
