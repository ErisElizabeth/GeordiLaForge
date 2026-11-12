'use strict';

/* Scheduling decisions only. The existing pollLoop owns execution and Elm owns
 * serialization. No transport calls, timers, or synthetic samples belong here. */
class FocusedPollingPlan {
  constructor(supported, sensorMask, definitions = PIDS) {
    const dynamic = [...new Set(supported)].filter(pid => definitions[pid] && !definitions[pid].static && pid !== 0x01);
    const available = new Set(dynamic);
    this.excluded = [];
    const oxygen = [0x14, 0x15].filter(pid => {
      const reason = !available.has(pid) ? 'not advertised or not decoded'
        : !supported.has(0x13) || sensorMask === null || sensorMask === undefined || supported.has(0x1D) ||
          !(sensorMask & (1 << (pid - 0x14))) ? 'Bank 1 location not verified' : null;
      if (reason) this.excluded.push({ pid, reason });
      return !reason;
    });
    const trims = [0x06, 0x07].filter(pid => {
      if (available.has(pid)) return true;
      this.excluded.push({ pid, reason: 'not advertised or not decoded' }); return false;
    });
    this.active = oxygen.length + trims.length > 0;
    this.priority = this.active ? [...new Set([...oxygen, ...trims, ...(available.has(0x0C) ? [0x0C] : [])])] : [];
    this.essential = [0x04, 0x11, 0x05, 0x03, 0x0D].filter(pid => available.has(pid) && !this.priority.includes(pid));
    this.other = dynamic.filter(pid => !this.priority.includes(pid) && !this.essential.includes(pid)).sort((a, b) => a - b);
    this.round = 0; this.essentialIndex = 0; this.otherIndex = 0;
    this.health = new Map(dynamic.map(pid => [pid, { pid, valid: 0, missing: 0, failed: 0,
      firstValidAt: null, lastValidAt: null, consecutiveFailures: 0, eligibleAt: 0 }]));
  }

  eligible(pid, now) { return this.health.has(pid) && this.health.get(pid).eligibleAt <= now; }

  _rotate(pool, indexKey, now) {
    for (let i = 0; i < pool.length; i++) {
      const pid = pool[this[indexKey]++ % pool.length];
      if (this.eligible(pid, now)) return pid;
    }
    return null;
  }

  nextBatch(now) {
    if (!this.active) return [];
    this.round++;
    const batch = this.priority.filter(pid => this.eligible(pid, now));
    const essential = this._rotate(this.essential, 'essentialIndex', now);
    if (essential !== null) batch.push(essential);
    if (this.round % 4 === 0 || !batch.length) {
      const other = this._rotate(this.other, 'otherIndex', now);
      if (other !== null) batch.push(other);
    }
    return [...new Set(batch)];
  }

  observe(pid, quality, now) {
    const stats = this.health.get(pid);
    if (!stats) return;
    const result = quality === 'valid' ? 'valid' : quality === 'missing' ? 'missing' : 'failed';
    stats[result]++;
    if (result === 'valid') {
      if (stats.firstValidAt === null) stats.firstValidAt = now;
      stats.lastValidAt = now; stats.consecutiveFailures = 0; stats.eligibleAt = 0;
    } else {
      stats.consecutiveFailures++;
      if (stats.consecutiveFailures >= 2) {
        stats.eligibleAt = now + 15000 * 2 ** Math.min(2, stats.consecutiveFailures - 2);
      }
    }
  }

  idleDelay(now) {
    const next = Math.min(...[...this.health.values()].map(stats => stats.eligibleAt));
    return Math.max(10, Math.min(250, next - now));
  }

  summary(now) {
    return [...this.health.values()].map(stats => ({ ...stats,
      rateHz: stats.valid >= 2 && stats.lastValidAt > stats.firstValidAt
        ? (stats.valid - 1) * 1000 / (stats.lastValidAt - stats.firstValidAt) : null,
      ageMs: stats.lastValidAt === null ? null : Math.max(0, now - stats.lastValidAt),
      retryMs: Math.max(0, stats.eligibleAt - now),
    }));
  }

  description() {
    return this.active
      ? 'Focused diagnostic: priority PIDs ' + this.priority.map(pid => pid.toString(16).toUpperCase().padStart(2, '0')).join(' ') +
        '; one eligible essential per round; one other every fourth round or while priority/context are waiting. Retry after 2 missing/invalid replies: 15/30/60 s.'
      : 'Focused requested, but no verified Bank 1 O2 or supported Bank 1 trim targets are available. Dashboard default schedule used.';
  }
}

/* Comparison profiles reuse M4's health, retry, and rotation implementation.
 * Verification reads are separate from the successfully-decoded scheduling pool. */
class ComparisonPollingPlan extends FocusedPollingPlan {
  constructor(profile, capabilities) {
    super(capabilities.supported, capabilities.masks[0x13] ?? null, capabilities.definitions);
    this.profile = profile; this.capabilities = capabilities; this.validationIndex = 0;
    this.excluded = []; this.targets = [];
    if (profile === 'oxygen-comparison') {
      for (const sensor of [1, 2]) for (const bank of [1, 2]) {
        const pid = [...this.health.keys()].find(candidate => {
          const location = capabilities.location(candidate);
          return location?.bank === bank && location.sensor === sensor;
        });
        if (pid === undefined) this.excluded.push({ label: 'B' + bank + 'S' + sensor, reason: 'No verified advertised O2 voltage PID' });
        else this.targets.push(pid);
      }
    } else if (profile === 'trim-comparison') {
      for (const pid of [0x06, 0x08, 0x07, 0x09]) {
        if (this.health.has(pid)) this.targets.push(pid);
        else this.excluded.push({ pid, reason: 'Not advertised or decoder unavailable' });
      }
    } else throw new Error('Unknown comparison profile');
    this.active = this.targets.length > 0;
    this.priority = this.targets.slice();
    this.essential = [0x05, 0x04, 0x11, 0x03].filter(pid => this.health.has(pid));
    this.rpm = this.health.has(0x0C) ? 0x0C : null;
    this.other = []; // Optional channels do not consume comparison bandwidth.
    this.candidates = [...new Set([...this.targets, ...(this.rpm === null ? [] : [this.rpm]), ...this.essential])];
  }

  eligible(pid, now) { return this.candidates.includes(pid) && this.capabilities.success(pid) && super.eligible(pid, now); }
  canValidate(pid, now) { return this.candidates.includes(pid) && !this.capabilities.success(pid) && super.eligible(pid, now); }

  nextValidation(now) {
    const pendingTargets = this.targets.filter(pid => !this.capabilities.success(pid));
    const pool = pendingTargets.some(pid => this.canValidate(pid, now)) ? pendingTargets : this.candidates;
    for (let i = 0; i < pool.length; i++) {
      const pid = pool[this.validationIndex++ % pool.length];
      if (this.canValidate(pid, now)) return pid;
    }
    return null;
  }

  nextBatch(now) {
    if (!this.active) return [];
    this.round++;
    const offset = (this.round - 1) % this.targets.length;
    const ordered = [...this.targets.slice(offset), ...this.targets.slice(0, offset)];
    const batch = ordered.filter(pid => this.eligible(pid, now));
    if (this.rpm !== null && (this.profile === 'trim-comparison' || this.round % 2 === 0) && this.eligible(this.rpm, now)) batch.push(this.rpm);
    if (this.round % 4 === 0 || !batch.length) {
      const context = this._rotate(this.essential, 'essentialIndex', now);
      if (context !== null) batch.push(context);
    }
    return [...new Set(batch)];
  }

  idleDelay(now) {
    const deadlines = this.candidates.map(pid => this.health.get(pid).eligibleAt);
    return Math.max(10, Math.min(250, Math.min(...deadlines) - now));
  }

  summary(now) { return super.summary(now).filter(stats => this.candidates.includes(stats.pid)); }

  description() {
    const name = this.profile === 'oxygen-comparison' ? 'Oxygen Sensor Comparison' : 'Fuel Trim Comparison';
    if (!this.active) return name + ': no suitable advertised targets; Dashboard default schedule used.';
    return name + ': fair target rotation after successful decoding; one advertised candidate validation per round. ' +
      (this.profile === 'oxygen-comparison' ? 'RPM every second round. ' : 'RPM each round. ') +
      'One essential condition every fourth round; no optional background. Existing 15/30/60 s retries apply.';
  }
}
