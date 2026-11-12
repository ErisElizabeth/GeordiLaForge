'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

function loadFiles(context, names) {
  for (const name of names) vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context, { filename: name });
}

function makeElement(tag = 'div') {
  const listeners = new Map();
  const node = { tagName: tag.toUpperCase(), children: [], dataset: {}, style: {}, attributes: {},
    value: '', disabled: false, className: '', width: 300, height: 150,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(name, fn) { listeners.set(name, fn); },
    async dispatch(name, event = {}) { return listeners.get(name)?.({ preventDefault() {}, ...event }); },
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
    querySelector(selector) {
      const cls = selector.slice(1);
      return this.children.find(child => child.attributes.class === cls || child.className === cls) || makeElement();
    },
    getBoundingClientRect() { return { width: 800, height: tag === 'canvas' ? 280 : 24, left: 0, top: 0 }; },
    getContext() { return { clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
      setTransform() {}, fillRect() {}, fillText() {}, arc() {}, rect() {}, fill() {} }; },
    showModal() {}, close() {},
  };
  let text = '';
  Object.defineProperties(node, {
    textContent: { get() { return text; }, set(value) { text = String(value); this.children = []; } },
    innerHTML: { get() { return ''; }, set() { text = ''; this.children = []; } },
    childNodes: { get() { return this.children; } },
    firstChild: { get() { return this.children[0]; } },
  });
  return node;
}

function harness({ fastTimers = true } = {}) {
  const nodes = new Map();
  const timers = new Set();
  const windowEvents = new Map();
  const uiTicks = [];
  const document = { documentElement: makeElement('html'),
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, makeElement());
      return nodes.get(selector);
    }, createElement: makeElement, createElementNS: (_, tag) => makeElement(tag),
    createTextNode: text => ({ textContent: text }) };
  const context = vm.createContext({ console, TextEncoder, TextDecoder, structuredClone, performance,
    document, navigator: {},
    localStorage: { getItem() { return null; }, setItem() {} },
    getComputedStyle() { return { getPropertyValue() { return '#2a78d6'; } }; },
    Audio: function() { return { play: async () => {}, currentTime: 0 }; },
    setTimeout(callback, delay) {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, fastTimers ? Math.min(delay, 2) : delay);
      timers.add(timer); return timer;
    }, clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    window: { confirm: () => true,
      addEventListener(name, callback) {
        if (!windowEvents.has(name)) windowEvents.set(name, []);
        windowEvents.get(name).push(callback);
      },
      setInterval(callback) { uiTicks.push(callback); return uiTicks.length; } },
  });
  loadFiles(context, ['pids.js', 'dtc-db.js', 'obd.js', 'demo.js', 'telemetry.js', 'graphs.js', 'graph-ui.js',
    'exports.js', 'report.js', 'export-ui.js', 'app.js']);
  return { context, run: code => vm.runInContext(code, context),
    node: id => document.querySelector('#' + id),
    click: id => document.querySelector('#' + id).dispatch('click'),
    tick: () => uiTicks.forEach(fn => fn()),
    pagehide: () => windowEvents.get('pagehide').forEach(fn => fn()),
    attach(pid01, { source = 'vehicle', supported = [0x06, 0x14], sensorMask = null } = {}) {
      context.testPid01 = pid01;
      context.testSupported = supported;
      context.testSource = source;
      context.testSensorMask = sensorMask;
      return vm.runInContext(`(() => {
        transport = { onDisconnect: null, disconnect() {} };
        elm = { pid01: testPid01, voltage: async () => 13.8 };
        state.connection = { id: ++connectionSerial, client: elm, transport,
          source: testSource, startedAt: new Date().toISOString() };
        state.supported = new Set(testSupported); state.sensorMask = testSensorMask;
        state.running = true;
        return state.connection.id;
      })()`, context);
    },
    close() {
      vm.runInContext('disconnectCurrent()', context);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

function recorderFixture(options = {}) {
  const time = { wallMs: Date.parse('2026-11-12T15:00:00.000Z'), monoMs: 1000 };
  const context = vm.createContext({ structuredClone, clock: () => ({ ...time }), options });
  loadFiles(context, ['telemetry.js']);
  const recorder = vm.runInContext('new TelemetryRecorder({ ...options, clock })', context);
  return { recorder, time, advance(ms) { time.wallMs += ms; time.monoMs += ms; },
    start: (extra = {}) => recorder.start({ connectionId: 1, source: 'vehicle', ...extra }),
    record(value, quality = 'valid', extra = {}) {
      return recorder.record(recorder.captureRequest(1), { pid: 0x06, label: 'Short fuel trim B1',
        unit: '%', value, quality, ...extra });
    } };
}

const plain = value => JSON.parse(JSON.stringify(value));
const waitFor = async (predicate, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

module.exports = { harness, recorderFixture, loadFiles, plain, waitFor };
