'use strict';

// Synthetic demo recordings only. These are never vehicle diagnostic evidence.
function recordedSession(count = 5) {
  const pids = [0x14, 0x15, 0x06, 0x07, 0x0C, 0x04, 0x11, 0x05, 0x0F];
  const units = ['V', 'V', '%', '%', 'rpm', '%', '%', '°C', '°C'];
  const start = Date.parse('2026-11-12T15:00:00Z'), duration = count ? count * 170 + 100 : 0;
  return { id: 'recording-fixture', connectionId: 2, source: 'demo', startedAt: new Date(start).toISOString(),
    endedAt: new Date(start + duration).toISOString(), endedElapsedMs: duration,
    stopReason: 'operator-stop', timingBasis: 'Browser receipt',
    metadata: { vin: 'KNDJF724X77012345', vehicleName: 'Æther', protocol: 'ISO 9141-2 (simulated)',
      supportedPids: pids, measurements: pids.map((pid, i) => ({pid, label:'PID ' + pid, unit:units[i], locationVerified:i < 2})) },
    notes: 'Warm idle, "approximately 2,000 RPM"\nÆther <measured> & recorded.',
    events: [{type:'recording-start', timestamp:new Date(start).toISOString(), elapsedMs:0, reason:null}],
    samples: Array.from({length:count}, (_, i) => {
      const slot = i % pids.length;
      const value = [0.65 + Math.sin(i / 7) * 0.25, 0.6 + Math.sin(i / 100) * 0.04,
        -12.5, 6.25, 850 + i % 1500, 20 + i % 60, 10 + i % 40, 88, 31][slot];
      return {mode:'01', pid:pids[slot], pidHex:pids[slot].toString(16).toUpperCase().padStart(2,'0'),
        label:'PID ' + pids[slot], unit:units[slot], locationVerified:slot < 2,
        timestamp:new Date(start + i * 170 + 100).toISOString(), elapsedMs:i * 170 + 100,
        requestedAt:new Date(start + i * 170).toISOString(), requestElapsedMs:i * 170, responseMs:100,
        quality:'valid', value, reason:null};
    }),
  };
}

module.exports = { recordedSession };
