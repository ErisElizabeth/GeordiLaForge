'use strict';
/* Simulated ELM327 + warmed-over 2007-ish four-cylinder, for testing without a car.
 * Implements the same transport contract as BleTransport. */

class DemoTransport {
  constructor() {
    this.onDisconnect = null;
    this._t0 = Date.now();
    this._supported = [
      0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10,
      0x11, 0x13, 0x14, 0x15, 0x1C, 0x1F, 0x21, 0x2E, 0x2F, 0x30, 0x31, 0x33,
      0x3C, 0x42, 0x43, 0x44, 0x45, 0x46, 0x51, 0x5C,
    ];
  }

  async connect(log) { log('Demo adapter attached (simulated 2.0L four-cylinder)'); }
  disconnect() { if (this.onDisconnect) this.onDisconnect(); }

  _now() { return (Date.now() - this._t0) / 1000; }

  _rpm() {
    const t = this._now();
    const cruise = Math.max(0, Math.sin(t / 11)) * 2400;         // periodic "drives"
    const blip = Math.max(0, Math.sin(t / 3.1 + 1)) * 300;
    return 820 + cruise + blip + Math.sin(t * 2.7) * 40;
  }
  _speed() { return Math.max(0, (this._rpm() - 950) / 32); }
  _coolant() { return Math.min(89, 21 + this._now() * 1.1); }
  _throttle() { return Math.min(92, Math.max(4, (this._rpm() - 750) / 28)); }

  _mask(base) {
    let v = 0;
    for (let i = 0; i < 31; i++)
      if (this._supported.includes(base + i + 1)) v |= 1 << (31 - i);
    if (this._supported.some(p => p > base + 0x20)) v |= 1;
    return v >>> 0;
  }

  _hex(bytes) { return bytes.map(b => (b & 0xff).toString(16).toUpperCase().padStart(2, '0')).join(''); }

  _pidBytes(pid) {
    const w = v => [v >> 8, v & 0xff];
    const rpm = this._rpm(), spd = this._speed(), th = this._throttle();
    switch (pid) {
      case 0x01: return this._cleared
        ? [0x00, 0x07, 0x65, 0x65]                       // cleared: MIL off, monitors reset
        : [0x82, 0x07, 0x65, 0x24];                      // MIL on, 2 codes, EVAP+O2 incomplete
      case 0x03: return [0x02, 0x00];
      case 0x04: return [Math.round(th * 2.2)];
      case 0x05: return [Math.round(this._coolant() + 40)];
      case 0x06: return [Math.round((Math.sin(this._now()) * 4 + 100) * 1.28)];
      case 0x07: return [Math.round((6.3 + 100) * 1.28)]; // lean-ish LTFT, matches P0171
      case 0x0B: return [Math.round(30 + th * 0.6)];
      case 0x0C: return w(Math.round(rpm * 4));
      case 0x0D: return [Math.round(spd)];
      case 0x0E: return [Math.round((12 + Math.sin(this._now()) * 3 + 64) * 2)];
      case 0x0F: return [Math.round(31 + 40)];
      case 0x10: return w(Math.round((2 + th * 0.55) * 100));
      case 0x11: return [Math.round(th * 2.55)];
      case 0x13: return [0x03];                          // B1 S1+S2
      case 0x14: return [Math.round((0.45 + Math.sin(this._now() * 5) * 0.35) * 200), 0xff];
      case 0x15: return [Math.round((0.6 + Math.sin(this._now() * 0.8) * 0.1) * 200), 0xff];
      case 0x1C: return [0x01];
      case 0x1F: return w(Math.round(this._now()));
      case 0x21: return w(742);
      case 0x2E: return [Math.round(th > 20 ? 90 : 10)];
      case 0x2F: return [Math.round(0.62 * 255)];
      case 0x30: return [14];
      case 0x31: return w(2381);
      case 0x33: return [99];
      case 0x3C: return w(Math.round((420 + th * 2 + 40) * 10));
      case 0x42: return w(Math.round((13.8 + Math.sin(this._now()) * 0.2) * 1000));
      case 0x43: return w(Math.round(th * 2.55));
      case 0x44: return w(Math.round(1.02 * 32768));
      case 0x45: return [Math.round(th * 2.55)];
      case 0x46: return [Math.round(24 + 40)];
      case 0x51: return [0x01];
      case 0x5C: return [Math.round(Math.min(95, this._coolant() + 6) + 40)];
      default: return null;
    }
  }

  async request(cmd, _timeout) {
    await new Promise(r => setTimeout(r, 60 + Math.random() * 60));
    const c = cmd.trim().toUpperCase().replace(/\s+/g, '');
    if (c === 'ATZ') return '\r\rELM327 v1.5 (demo)\r\r';
    if (c === 'ATRV') return (13.7 + Math.sin(this._now()) * 0.2).toFixed(1) + 'V\r';
    if (c === 'ATDP') return 'ISO 9141-2 (simulated)\r';
    if (c.startsWith('AT')) return 'OK\r';

    if (/^01[0-9A-F]{2}$/.test(c)) {
      const pid = parseInt(c.slice(2), 16);
      if ((pid & 0x1f) === 0 && pid <= 0x60) {
        const m = this._mask(pid);
        return '41' + this._hex([pid]) + this._hex([m >>> 24, m >>> 16, m >>> 8, m]) + '\r';
      }
      const b = this._pidBytes(pid);
      return b ? '41' + this._hex([pid]) + this._hex(b) + '\r' : 'NO DATA\r';
    }
    if (c === '03') return this._cleared ? '43000000000000\r' : '43030101710000\r'; // P0301 + P0171
    if (c === '07') return this._cleared ? '47000000000000\r' : '47042000000000\r'; // pending P0420
    if (c === '04') { this._cleared = true; return '44\r'; }
    if (c === '0902') {
      // ISO-style: 5 frames of "49 02 <seq> + 4 bytes"; 3 leading pad zeros + 17-char VIN
      const vin = 'KNDDEM0DASH123456';
      const bytes = [0, 0, 0].concat(Array.from(vin, ch => ch.charCodeAt(0)));
      let out = '';
      for (let f = 0; f < 5; f++)
        out += '4902' + this._hex([f + 1].concat(bytes.slice(f * 4, f * 4 + 4))) + '\r';
      return out;
    }
    if (/^02[0-9A-F]{2}00$/.test(c)) {
      if (this._cleared) return 'NO DATA\r';
      const pid = parseInt(c.slice(2, 4), 16);
      if (pid === 0x02) return '4202000301\r';           // freeze DTC = P0301
      const b = this._pidBytes(pid);
      return b ? '42' + this._hex([pid, 0]) + this._hex(b) + '\r' : 'NO DATA\r';
    }
    return '?\r';
  }
}
