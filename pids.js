'use strict';
/* Mode 01 PID table. decode() receives the data bytes AFTER "41 <pid>".
 * Numeric PIDs: { name, cat, unit, min, max, dec, decode, imp? }
 *   imp: { unit, f } — imperial display conversion.
 * Text PIDs: { text: true, decode -> string }. Static PIDs are read once. */

const W = b => (b[0] << 8) + b[1];
const PCT = b => b[0] / 2.55;
const TEMP = b => b[0] - 40;
const TRIM = b => b[0] / 1.28 - 100;

const IMP_F   = { unit: '°F',  f: v => v * 9 / 5 + 32 };
const IMP_MPH = { unit: 'mph', f: v => v * 0.621371 };
const IMP_MI  = { unit: 'mi',  f: v => v * 0.621371 };
const IMP_PSI = { unit: 'psi', f: v => v * 0.145038 };

const FUEL_SYS = { 0: 'Off', 1: 'Open loop (warm-up)', 2: 'Closed loop', 4: 'Open loop (load/decel)',
                   8: 'Open loop (fault)', 16: 'Closed loop (O2 fault)' };
const OBD_STD = { 1: 'OBD-II (CARB)', 2: 'OBD (EPA)', 3: 'OBD & OBD-II', 4: 'OBD-I', 5: 'None',
                  6: 'EOBD', 7: 'EOBD & OBD-II', 8: 'EOBD & OBD', 9: 'EOBD, OBD & OBD-II',
                  10: 'JOBD', 11: 'JOBD & OBD-II', 12: 'JOBD & EOBD', 13: 'JOBD, EOBD & OBD-II' };
const FUEL_TYPE = { 0: 'Not available', 1: 'Gasoline', 2: 'Methanol', 3: 'Ethanol', 4: 'Diesel',
                    5: 'LPG', 6: 'CNG', 7: 'Propane', 8: 'Electric', 17: 'Hybrid gasoline' };

function o2Present(b) {
  const v = b[0], out = [];
  for (let bank = 0; bank < 2; bank++) {
    const s = [];
    for (let i = 0; i < 4; i++) if (v & (1 << (bank * 4 + i))) s.push('S' + (i + 1));
    if (s.length) out.push('B' + (bank + 1) + ': ' + s.join(','));
  }
  return out.join('  ') || 'None reported';
}

const PIDS = {
  0x03: { name: 'Fuel system status', cat: 'fuel', text: true,
          decode: b => {
            const a = FUEL_SYS[b[0]] || ('Code ' + b[0]);
            return b.length > 1 && b[1] ? a + ' / ' + (FUEL_SYS[b[1]] || b[1]) : a;
          } },
  0x04: { name: 'Engine load', unit: '%', min: 0, max: 100, dec: 0, decode: PCT },
  0x05: { name: 'Coolant temp', unit: '°C', min: -40, max: 130, dec: 0, decode: TEMP, imp: IMP_F },
  0x06: { name: 'Short fuel trim B1', unit: '%', min: -25, max: 25, dec: 1, decode: TRIM },
  0x07: { name: 'Long fuel trim B1', unit: '%', min: -25, max: 25, dec: 1, decode: TRIM },
  0x08: { name: 'Short fuel trim B2', unit: '%', min: -25, max: 25, dec: 1, decode: TRIM },
  0x09: { name: 'Long fuel trim B2', unit: '%', min: -25, max: 25, dec: 1, decode: TRIM },
  0x0A: { name: 'Fuel pressure', unit: 'kPa', min: 0, max: 765, dec: 0, decode: b => b[0] * 3, imp: IMP_PSI },
  0x0B: { name: 'Intake manifold pressure', unit: 'kPa', min: 0, max: 255, dec: 0, decode: b => b[0], imp: IMP_PSI },
  0x0C: { name: 'Engine RPM', unit: 'rpm', min: 0, max: 8000, dec: 0, decode: b => W(b) / 4 },
  0x0D: { name: 'Vehicle speed', unit: 'km/h', min: 0, max: 240, dec: 0, decode: b => b[0], imp: IMP_MPH },
  0x0E: { name: 'Timing advance', unit: '°', min: -64, max: 64, dec: 1, decode: b => b[0] / 2 - 64 },
  0x0F: { name: 'Intake air temp', unit: '°C', min: -40, max: 120, dec: 0, decode: TEMP, imp: IMP_F },
  0x10: { name: 'MAF air flow', unit: 'g/s', min: 0, max: 200, dec: 1, decode: b => W(b) / 100 },
  0x11: { name: 'Throttle position', unit: '%', min: 0, max: 100, dec: 0, decode: PCT },
  0x13: { name: 'O2 sensors present', text: true, static: true, decode: o2Present },
  0x14: { name: 'O2 B1S1 voltage', unit: 'V', min: 0, max: 1.275, dec: 2, decode: b => b[0] / 200 },
  0x15: { name: 'O2 B1S2 voltage', unit: 'V', min: 0, max: 1.275, dec: 2, decode: b => b[0] / 200 },
  0x16: { name: 'O2 B1S3 voltage', unit: 'V', min: 0, max: 1.275, dec: 2, decode: b => b[0] / 200 },
  0x17: { name: 'O2 B1S4 voltage', unit: 'V', min: 0, max: 1.275, dec: 2, decode: b => b[0] / 200 },
  0x18: { name: 'O2 B2S1 voltage', unit: 'V', min: 0, max: 1.275, dec: 2, decode: b => b[0] / 200 },
  0x19: { name: 'O2 B2S2 voltage', unit: 'V', min: 0, max: 1.275, dec: 2, decode: b => b[0] / 200 },
  0x1A: { name: 'O2 B2S3 voltage', unit: 'V', min: 0, max: 1.275, dec: 2, decode: b => b[0] / 200 },
  0x1B: { name: 'O2 B2S4 voltage', unit: 'V', min: 0, max: 1.275, dec: 2, decode: b => b[0] / 200 },
  0x1C: { name: 'OBD standard', text: true, static: true, decode: b => OBD_STD[b[0]] || ('Code ' + b[0]) },
  0x1F: { name: 'Engine run time', unit: '', min: 0, max: 65535, dec: 0, decode: W,
          fmt: v => { const m = Math.floor(v / 60), s = v % 60; return m + 'm ' + String(s).padStart(2, '0') + 's'; } },
  0x21: { name: 'Distance with MIL on', unit: 'km', min: 0, max: 65535, dec: 0, decode: W, imp: IMP_MI },
  0x22: { name: 'Fuel rail pressure (rel)', unit: 'kPa', min: 0, max: 5178, dec: 0, decode: b => W(b) * 0.079, imp: IMP_PSI },
  0x23: { name: 'Fuel rail pressure', unit: 'kPa', min: 0, max: 655350, dec: 0, decode: b => W(b) * 10, imp: IMP_PSI },
  0x2C: { name: 'Commanded EGR', unit: '%', min: 0, max: 100, dec: 0, decode: PCT },
  0x2D: { name: 'EGR error', unit: '%', min: -100, max: 100, dec: 1, decode: TRIM },
  0x2E: { name: 'Evap purge', unit: '%', min: 0, max: 100, dec: 0, decode: PCT },
  0x2F: { name: 'Fuel level', unit: '%', min: 0, max: 100, dec: 0, decode: PCT },
  0x30: { name: 'Warm-ups since clear', unit: '', min: 0, max: 255, dec: 0, decode: b => b[0] },
  0x31: { name: 'Distance since clear', unit: 'km', min: 0, max: 65535, dec: 0, decode: W, imp: IMP_MI },
  0x32: { name: 'Evap vapor pressure', unit: 'Pa', min: -8192, max: 8192, dec: 0,
          decode: b => { let v = W(b); if (v > 32767) v -= 65536; return v / 4; } },
  0x33: { name: 'Barometric pressure', unit: 'kPa', min: 60, max: 110, dec: 0, decode: b => b[0], imp: IMP_PSI },
  0x3C: { name: 'Catalyst temp B1S1', unit: '°C', min: 0, max: 900, dec: 0, decode: b => W(b) / 10 - 40, imp: IMP_F },
  0x3D: { name: 'Catalyst temp B2S1', unit: '°C', min: 0, max: 900, dec: 0, decode: b => W(b) / 10 - 40, imp: IMP_F },
  0x3E: { name: 'Catalyst temp B1S2', unit: '°C', min: 0, max: 900, dec: 0, decode: b => W(b) / 10 - 40, imp: IMP_F },
  0x3F: { name: 'Catalyst temp B2S2', unit: '°C', min: 0, max: 900, dec: 0, decode: b => W(b) / 10 - 40, imp: IMP_F },
  0x42: { name: 'Module voltage', unit: 'V', min: 8, max: 16, dec: 2, decode: b => W(b) / 1000 },
  0x43: { name: 'Absolute load', unit: '%', min: 0, max: 200, dec: 0, decode: b => W(b) * 100 / 255 },
  0x44: { name: 'Commanded lambda', unit: 'λ', min: 0.5, max: 1.5, dec: 3, decode: b => W(b) / 32768 },
  0x45: { name: 'Relative throttle', unit: '%', min: 0, max: 100, dec: 0, decode: PCT },
  0x46: { name: 'Ambient air temp', unit: '°C', min: -40, max: 60, dec: 0, decode: TEMP, imp: IMP_F },
  0x47: { name: 'Throttle position B', unit: '%', min: 0, max: 100, dec: 0, decode: PCT },
  0x48: { name: 'Throttle position C', unit: '%', min: 0, max: 100, dec: 0, decode: PCT },
  0x49: { name: 'Accelerator pedal D', unit: '%', min: 0, max: 100, dec: 0, decode: PCT },
  0x4A: { name: 'Accelerator pedal E', unit: '%', min: 0, max: 100, dec: 0, decode: PCT },
  0x4C: { name: 'Commanded throttle', unit: '%', min: 0, max: 100, dec: 0, decode: PCT },
  0x51: { name: 'Fuel type', text: true, static: true, decode: b => FUEL_TYPE[b[0]] || ('Code ' + b[0]) },
  0x5C: { name: 'Engine oil temp', unit: '°C', min: -40, max: 160, dec: 0, decode: TEMP, imp: IMP_F },
  0x5E: { name: 'Fuel rate', unit: 'L/h', min: 0, max: 100, dec: 1, decode: b => W(b) / 20 },
};

/* PIDs shown in the hero gauges when supported */
const GAUGE_PIDS = [
  { pid: 0x0C, max: 7000 },
  { pid: 0x0D, max: 240 },
  { pid: 0x05, max: 130 },
];

/* Polled every cycle (fast); everything else supported rotates one per cycle */
const FAST_PIDS = [0x0C, 0x0D, 0x04, 0x11, 0x05];

/* Freeze-frame PIDs worth fetching (plus 0x02 = the DTC that froze the frame) */
const FREEZE_PIDS = [0x04, 0x05, 0x06, 0x07, 0x0B, 0x0C, 0x0D, 0x0F, 0x10, 0x11, 0x2F];
