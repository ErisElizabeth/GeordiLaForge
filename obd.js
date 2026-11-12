'use strict';
/* BLE transport + ELM327 session layer.
 * Transport contract: connect(log), disconnect(), request(cmd, timeoutMs) -> raw text
 * up to (not including) the '>' prompt, onDisconnect callback. */

const BLE_SERVICES = [
  0xfff0, 0xffe0, 0xffb0, 0xae00, 0xabf0, 0x18f0, 0xffd0, 0xfee7, 0xfd00, 0xff00, 0xffa0,
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',           // Vgate iCar Pro & friends
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',           // Microchip transparent UART (OBDLink CX)
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',           // Nordic UART (very common on BLE modules)
  '0000fff0-0000-1000-8000-00805f9b34fb',
  '00001101-0000-1000-8000-00805f9b34fb',           // SPP-over-GATT on some clones
];

/* Try the services most likely to be the real UART first. ae00 is deliberately last:
 * the ViaBecs advertises it with a valid-looking write/notify pair that never replies. */
const KNOWN_UART_ORDER = [
  'fff0', 'ffe0', 'ffb0', 'abf0', '18f0', 'ffd0', 'fee7', 'ff00', 'ffa0',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  'ae00',
];

const shortUuid = u =>
  (/^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(u) || [0, u])[1];

/* Windows' BLE stack can resolve gatt.connect() a beat before the link is usable,
 * and one-client adapters drop a second caller outright. Retry, and verify. */
async function gattConnect(dev, log, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const server = await dev.gatt.connect();
      await new Promise(r => setTimeout(r, 400));
      if (dev.gatt.connected) return server;
      log('link dropped right after connect (attempt ' + i + '/' + tries + ')');
    } catch (e) {
      log('connect attempt ' + i + '/' + tries + ' failed: ' + e.message);
    }
    try { dev.gatt.disconnect(); } catch (e) {}
    await new Promise(r => setTimeout(r, 700));
  }
  throw new Error('The adapter accepted the Bluetooth link then immediately dropped it. ' +
    'That almost always means something else already holds it: unplug the dongle for 10 seconds, ' +
    'remove any Windows or phone pairing to "OBDII", close other tabs of this page, then retry.');
}

class BleTransport {
  constructor() {
    this.device = null; this.tx = null; this.rx = null;
    this.onDisconnect = null;
    this._buf = ''; this._pending = null;
    this._decoder = new TextDecoder(); this._encoder = new TextEncoder();
    this._onValue = ev => this._onChunk(this._decoder.decode(ev.target.value));
  }

  /* Bind a candidate pair, replacing any previous subscription. */
  async _bind(p) {
    if (this.rx) {
      this.rx.removeEventListener('characteristicvaluechanged', this._onValue);
      try { await this.rx.stopNotifications(); } catch (e) { /* already gone */ }
    }
    this.rx = p.n; this.tx = p.w;
    await this.rx.startNotifications();
    this.rx.addEventListener('characteristicvaluechanged', this._onValue);
  }

  async connect(log) {
    this.device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: BLE_SERVICES,
    });
    log('Device: ' + (this.device.name || '(unnamed)'));
    this.device.addEventListener('gattserverdisconnected', () => {
      if (this.onDisconnect) this.onDisconnect();
    });
    const server = await gattConnect(this.device, m => log(m));

    let services = [];
    try { services = await server.getPrimaryServices(); } catch (e) { /* some stacks refuse the blanket call */ }
    if (!services.length) {
      for (const uuid of BLE_SERVICES) {
        try { services.push(await server.getPrimaryService(uuid)); } catch (e) { /* not present */ }
      }
    }
    /* Build every notify+write pair. Adapters advertise decoy services that look
     * perfectly valid and never answer (the ViaBecs' ae00 is one), so the channel
     * has to be proven with a real ATZ rather than assumed from its properties. */
    const pairs = [];
    for (const svc of services) {
      let chars = [];
      try { chars = await svc.getCharacteristics(); } catch (e) { continue; }
      const ns = chars.filter(c => c.properties.notify || c.properties.indicate);
      const ws = chars.filter(c => c.properties.write || c.properties.writeWithoutResponse);
      for (const n of ns) for (const w of ws) pairs.push({ svc, n, w });
    }
    if (!pairs.length)
      throw new Error('No serial-style service found on this device — is it really the OBD adapter?');

    const rank = u => {
      const i = KNOWN_UART_ORDER.indexOf(shortUuid(u));
      return i < 0 ? KNOWN_UART_ORDER.length : i;
    };
    pairs.sort((a, b) => rank(a.svc.uuid) - rank(b.svc.uuid));

    for (const p of pairs) {
      await this._bind(p);
      const reply = await this.request('ATZ', 2500);
      if (/ELM|OK|\?/i.test(reply)) {
        log('channel: service ' + shortUuid(p.svc.uuid) +
            ' write ' + shortUuid(p.w.uuid) + ' notify ' + shortUuid(p.n.uuid));
        return;
      }
      log('silent on service ' + shortUuid(p.svc.uuid) + ' (' + shortUuid(p.w.uuid) + '/' + shortUuid(p.n.uuid) + ')');
    }
    throw new Error('Found ' + pairs.length + ' candidate channel(s) but none answered. ' +
      'Unplug the dongle for 10 seconds and retry; if it persists, run "Diagnose adapter".');
  }

  disconnect() {
    try { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) {}
  }

  _onChunk(text) {
    this._buf += text;
    if (this._buf.includes('>') && this._pending) {
      const p = this._pending; this._pending = null;
      clearTimeout(p.timer);
      p.resolve(this._buf.replace(/>/g, ''));
    }
  }

  async request(cmd, timeoutMs = 8000) {
    this._buf = '';
    const done = new Promise(resolve => {
      this._pending = {
        resolve,
        timer: setTimeout(() => {              // resolve with whatever arrived; caller decides
          if (this._pending) { this._pending = null; resolve(this._buf); }
        }, timeoutMs),
      };
    });
    const data = this._encoder.encode(cmd + '\r');
    for (let i = 0; i < data.length; i += 20) {
      const chunk = data.slice(i, i + 20);
      if (this.tx.properties.writeWithoutResponse) await this.tx.writeValueWithoutResponse(chunk);
      else await this.tx.writeValueWithResponse(chunk);
    }
    return done;
  }
}

/* ---------------- ELM327 session ---------------- */

const hex2 = n => n.toString(16).toUpperCase().padStart(2, '0');

class Elm {
  constructor(transport, log) {
    this.t = transport;
    this.log = log || (() => {});
    this._q = Promise.resolve();
  }

  cmd(c, timeout) {
    const run = () => this._exec(c, timeout);
    this._q = this._q.then(run, run);
    return this._q;
  }

  async _exec(c, timeout) {
    this.log('tx', c);
    const raw = await this.t.request(c, timeout);
    this.log('rx', raw.replace(/[\r\n]+/g, ' | ').trim());
    return raw;
  }

  async init() {
    const id = await this.cmd('ATZ', 7000);
    for (const c of ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAT1', 'ATSP0']) await this.cmd(c, 4000);
    const m = id.match(/ELM327[^\r\n>]*/);
    return m ? m[0].trim() : 'ELM327 (no ident)';
  }

  /* Split raw response into arrays of bytes, merging ISO-TP "N:" framed lines. */
  _byteLines(raw) {
    const lines = raw.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);
    const out = [];
    let framed = null;
    for (let s of lines) {
      if (/SEARCHING|BUS INIT|STOPPED|ELM327|NO DATA|UNABLE|ERROR|^OK$|^\?$/i.test(s)) continue;
      const fm = s.match(/^([0-9A-F]{1,2}):(.*)$/i);
      if (fm) {
        if (framed === null) framed = '';
        framed += fm[2].replace(/\s+/g, '');
        continue;
      }
      s = s.replace(/\s+/g, '');
      if (!/^[0-9A-F]+$/i.test(s)) continue;
      if (s.length === 3) continue;              // ISO-TP total-length hint line
      if (s.length % 2) continue;
      out.push(s.match(/../g).map(h => parseInt(h, 16)));
    }
    if (framed !== null && framed.length >= 2 && framed.length % 2 === 0)
      out.push(framed.match(/../g).map(h => parseInt(h, 16)));
    return out;
  }

  /* Mode 01 request; returns data bytes after "41 <pid>", or null. */
  async pid01(pid, timeout = 6000) {
    const raw = await this.cmd('01' + hex2(pid), timeout);
    if (/UNABLE TO CONNECT/i.test(raw)) throw new Error('Adapter cannot reach the ECU — is the ignition on?');
    for (const a of this._byteLines(raw))
      if (a[0] === 0x41 && a[1] === pid) return a.slice(2);
    return null;
  }

  /* Bitmap walk of supported mode-01 PIDs. */
  async supportedPids() {
    const out = new Set();
    for (let base = 0x00; base <= 0xE0; base += 0x20) {
      const b = await this.pid01(base, base === 0 ? 20000 : 8000);   // first query rides the bus search
      if (!b || b.length < 4) break;
      const v = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
      for (let i = 0; i < 31; i++) if ((v >>> (31 - i)) & 1) out.add(base + i + 1);
      if (!(v & 1)) break;                       // bit 32 = next range exists
    }
    return out;
  }

  /* Mode 01 PID 01: MIL, code count, readiness monitors. */
  async status() {
    const b = await this.pid01(0x01);
    if (!b || b.length < 4) return null;
    const spark = !(b[1] & 0x08);
    const cont = [
      { name: 'Misfire', avail: !!(b[1] & 0x01), done: !(b[1] & 0x10) },
      { name: 'Fuel system', avail: !!(b[1] & 0x02), done: !(b[1] & 0x20) },
      { name: 'Components', avail: !!(b[1] & 0x04), done: !(b[1] & 0x40) },
    ];
    const names = spark
      ? ['Catalyst', 'Heated catalyst', 'EVAP system', 'Secondary air', 'A/C refrigerant', 'O2 sensor', 'O2 heater', 'EGR system']
      : ['NMHC catalyst', 'NOx aftertreatment', '(reserved)', 'Boost pressure', '(reserved)', 'Exhaust sensor', 'PM filter', 'EGR/VVT'];
    const noncont = names.map((name, i) => ({
      name, avail: !!(b[2] & (1 << i)), done: !(b[3] & (1 << i)),
    }));
    return { mil: !!(b[0] & 0x80), count: b[0] & 0x7f, monitors: cont.concat(noncont) };
  }

  _dtcFromBytes(a, b) {
    if (a === 0 && b === 0) return null;
    const sys = ['P', 'C', 'B', 'U'][a >> 6];
    return sys + ((a >> 4) & 3).toString() +
      (a & 0xf).toString(16).toUpperCase() +
      (b >> 4).toString(16).toUpperCase() +
      (b & 0xf).toString(16).toUpperCase();
  }

  /* Modes 03 (stored) / 07 (pending). */
  async readDtcs(mode) {
    const reply = mode + 0x40;
    const raw = await this.cmd(hex2(mode), 10000);
    const codes = [];
    for (const a of this._byteLines(raw)) {
      if (a[0] !== reply) continue;
      let rest = a.slice(1);
      if (rest.length % 2 === 1) rest = rest.slice(1);   // CAN prefixes a count byte
      for (let i = 0; i + 1 < rest.length; i += 2) {
        const c = this._dtcFromBytes(rest[i], rest[i + 1]);
        if (c && !codes.includes(c)) codes.push(c);
      }
    }
    return codes;
  }

  async clearDtcs() {
    const raw = await this.cmd('04', 10000);
    return /44|OK/i.test(raw);
  }

  /* Mode 09 PID 02: VIN. */
  async readVin() {
    const raw = await this.cmd('0902', 10000);
    let chars = [];
    for (const a of this._byteLines(raw)) {
      for (let i = 0; i + 1 < a.length; i++) {
        if (a[i] === 0x49 && a[i + 1] === 0x02) {
          chars = chars.concat(a.slice(i + 3));          // skip 49 02 <seq>
          break;
        }
      }
    }
    const vin = chars.filter(c => c >= 0x20 && c < 0x7f).map(c => String.fromCharCode(c)).join('');
    return vin.length >= 17 ? vin.slice(-17) : (vin || null);
  }

  /* Mode 02: freeze frame 0. Returns data bytes after "42 <pid> <frame>". */
  async freeze(pid) {
    const raw = await this.cmd('02' + hex2(pid) + '00', 6000);
    for (const a of this._byteLines(raw))
      if (a[0] === 0x42 && a[1] === pid) return a.slice(3);
    return null;
  }

  async voltage() {
    const raw = await this.cmd('ATRV', 4000);
    const m = raw.match(/(\d+\.?\d*)\s*V/i);
    return m ? parseFloat(m[1]) : null;
  }

  async protocol() {
    const raw = await this.cmd('ATDP', 4000);
    return raw.replace(/AUTO,?\s*/i, '').replace(/[\r\n>]/g, ' ').trim() || 'unknown';
  }
}
