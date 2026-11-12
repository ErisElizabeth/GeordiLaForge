'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {loadFiles, harness, plain, waitFor} = require('./helpers.js');

const supported = [0x03,0x04,0x05,0x06,0x07,0x0C,0x0D,0x0F,0x10,0x11,0x13,0x14,0x15];
function planner(pids = supported, mask = 3) {
  const context = vm.createContext({}); loadFiles(context, ['pids.js','polling.js']);
  const Plan = vm.runInContext('FocusedPollingPlan', context);
  return new Plan(new Set(pids), mask);
}
function bytesFor(pid) {
  return pid === 0x0C ? [0x0F,0xA0] : pid === 0x14 || pid === 0x15 ? [100,255] : pid === 0x03 ? [2,0] : [128];
}

test('focus prioritizes verified O2, Bank 1 trims and RPM, with disjoint background pools', () => {
  const plan = planner();
  assert.deepEqual(plain(plan.priority), [0x14,0x15,0x06,0x07,0x0C]);
  assert.deepEqual(plain(plan.essential), [0x04,0x11,0x05,0x03,0x0D]);
  assert.deepEqual(plain(plan.other), [0x0F,0x10]);
  const all = [...plan.priority,...plan.essential,...plan.other];
  assert.equal(all.length, new Set(all).size);
  assert.equal(all.includes(0x13), false);
  assert.deepEqual(plain(plan.nextBatch(0)), [0x14,0x15,0x06,0x07,0x0C,0x04]);
  assert.deepEqual(plain(plan.nextBatch(0)), [0x14,0x15,0x06,0x07,0x0C,0x11]);
  assert.deepEqual(plain(plan.nextBatch(0)), [0x14,0x15,0x06,0x07,0x0C,0x05]);
  assert.deepEqual(plain(plan.nextBatch(0)), [0x14,0x15,0x06,0x07,0x0C,0x03,0x0F]);
});

test('every other live PID remains in a fair rotation and no batch has duplicate requests', () => {
  const plan = planner(); const seen = new Set();
  for (let i=0;i<12;i++) {
    const batch = plan.nextBatch(i*1000);
    assert.equal(batch.length, new Set(batch).size);
    batch.forEach(pid=>seen.add(pid));
  }
  assert.deepEqual([...seen].sort((a,b)=>a-b), supported.filter(pid=>pid!==0x13).sort((a,b)=>a-b));
});

test('unsupported or unverified oxygen locations are never promoted to Bank 1 priority', () => {
  for (const [pids,mask] of [[supported,null], [supported,0], [[...supported,0x1D],3], [supported.filter(pid=>pid!==0x13),3]]) {
    const plan = planner(pids,mask);
    assert.equal(plan.priority.includes(0x14), false);
    assert.equal(plan.priority.includes(0x15), false);
    assert.equal(plan.active, true); // Supported B1 trims still have a useful focus.
    assert.ok(plan.excluded.some(item=>item.reason.includes('not verified')));
  }
  const onlyOne = planner(supported.filter(pid=>pid!==0x15), 3);
  assert.equal(onlyOne.priority.includes(0x14), true);
  assert.equal(onlyOne.health.has(0x15), false);
  assert.equal(onlyOne.other.includes(0x15), false);
});

test('no diagnostic targets produces an explicit default-schedule fallback', () => {
  const plan = planner([0x0C,0x05,0x13],0);
  assert.equal(plan.active,false);
  assert.deepEqual(plain(plan.nextBatch(0)),[]);
  assert.match(plan.description(),/Dashboard default schedule used/);
});

test('focused missing and invalid replies trigger bounded 15/30/60-second retry delays', () => {
  const plan = planner();
  plan.observe(0x14,'missing',100);
  assert.equal(plan.eligible(0x14,101),true);
  plan.observe(0x14,'failed',200);
  assert.equal(plan.eligible(0x14,15199),false);
  assert.equal(plan.eligible(0x14,15200),true);
  assert.equal(plan.nextBatch(500).includes(0x14),false);
  assert.equal(plan.nextBatch(500).includes(0x15),true);
  plan.observe(0x14,'missing',15200);
  assert.equal(plan.health.get(0x14).eligibleAt,45200);
  plan.observe(0x14,'missing',45200);
  assert.equal(plan.health.get(0x14).eligibleAt,105200);
  plan.observe(0x14,'missing',105200);
  assert.equal(plan.health.get(0x14).eligibleAt,165200);
  plan.observe(0x14,'valid',165200);
  assert.equal(plan.health.get(0x14).eligibleAt,0);
  assert.equal(plan.health.get(0x14).consecutiveFailures,0);
  plan.observe(0x14,'missing',165300);
  assert.equal(plan.eligible(0x14,165301),true);
});

test('health rates use actual valid timestamps, include communication gaps, and keep bounded state', () => {
  const plan = planner();
  plan.observe(0x14,'valid',0);
  assert.equal(plan.summary(1000).find(s=>s.pid===0x14).rateHz,null);
  plan.observe(0x14,'missing',2000); plan.observe(0x14,'valid',5000);
  const stats=plan.summary(6000).find(s=>s.pid===0x14);
  assert.equal(stats.rateHz,0.2); assert.equal(stats.ageMs,1000); assert.equal(stats.missing,1);
  const size=plan.health.size;
  for(let i=1;i<=20000;i++)plan.observe(0x06,'valid',i*10);
  assert.equal(plan.health.size,size);
  assert.equal(plan.health.get(0x06).valid,20000);
});

test('all-waiting plans return no requests and use a bounded idle delay', () => {
  const plan = planner([0x13,0x14,0x15],3);
  for(const pid of [0x14,0x15]) {plan.observe(pid,'missing',0);plan.observe(pid,'missing',0);}
  assert.deepEqual(plain(plan.nextBatch(100)),[]);
  assert.equal(plan.idleDelay(100),250);
  assert.equal(plan.idleDelay(14995),10);
  assert.deepEqual(plain(plan.nextBatch(15000)),[0x14,0x15]);
});

test('mode changes are refused during a recording, with one saved policy and no new polling loop', async t => {
  const h=harness();t.after(()=>h.close());
  h.attach(async pid=>bytesFor(pid),{supported,sensorMask:3,source:'demo'});
  const loopId=h.run('pollSession');
  assert.equal(h.run('setPollingMode("focused")'),true);
  assert.equal(h.run('pollSession'),loopId);
  await h.click('btnRecordStart');
  assert.equal(h.node('pollingMode').disabled,true);
  assert.equal(h.run('setPollingMode("dashboard")'),false);
  assert.equal(h.run('state.pollingMode'),'focused');
  assert.equal(h.run('recorder.session.metadata.polling.mode'),'focused');
  assert.equal(h.run('recorder.session.events.filter(event=>event.type==="sampling-mode").length'),1);
  await h.run('samplePid(0x14)');await h.click('btnRecordStop');
  assert.equal(h.run('setPollingMode("dashboard")'),true);
  assert.equal(h.run('recorder.session.metadata.polling.mode'),'focused');
  assert.match(h.node('pollingModeStatus').textContent,/SIMULATED DATA/);
});

test('in-flight default requests finish, then the existing loop immediately adopts focus', async t => {
  const h=harness();t.after(()=>h.close());let resolve;const seen=[];
  h.attach(pid=>{
    seen.push(pid);
    if(seen.length===1)return new Promise(r=>{resolve=r;});
    if(seen.length===7)h.run('state.running=false');
    return Promise.resolve(bytesFor(pid));
  },{supported,sensorMask:3});
  h.run('state.fast=FAST_PIDS.slice();state.slow=[0x03,0x06,0x07]');
  const pending=h.run('pollLoop()'),loopId=h.run('pollSession'),client=h.run('elm');
  h.run('setPollingMode("focused")');await h.click('btnRecordStart');
  resolve(bytesFor(0x0C));await pending;
  assert.deepEqual(seen,[0x0C,0x14,0x15,0x06,0x07,0x0C,0x04]);
  assert.equal(h.run('pollSession'),loopId);assert.equal(h.run('elm'),client);
  assert.deepEqual(plain(h.run('recorder.session.samples.map(sample=>sample.pid)')),seen.slice(1));
  assert.equal(h.run('state.focusPlan.health.get(0x0C).valid'),1);
});

test('switching back to default abandons the old focused batch and restores original order', async t => {
  const h=harness();t.after(()=>h.close());let resolve;const seen=[];
  h.attach(pid=>{
    seen.push(pid);
    if(seen.length===1)return new Promise(r=>{resolve=r;});
    if(seen.length===6)h.run('state.running=false');
    return Promise.resolve(bytesFor(pid));
  },{supported,sensorMask:3});
  h.run('state.fast=FAST_PIDS.slice();state.slow=[0x06];setPollingMode("focused")');
  const oldPlan=h.run('state.focusPlan'),pending=h.run('pollLoop()');
  h.run('setPollingMode("dashboard")');resolve(bytesFor(0x14));await pending;
  assert.deepEqual(seen,[0x14,0x0C,0x0D,0x04,0x11,0x05]);
  assert.equal(oldPlan.health.get(0x14).valid,0);
});

test('fallback focus selection executes the unchanged dashboard schedule', async t => {
  const h=harness();t.after(()=>h.close());const seen=[];
  h.attach(async pid=>{seen.push(pid);if(seen.length===4)h.run('state.running=false');return bytesFor(pid);},
    {supported:[0x0C,0x05],sensorMask:null});
  h.run('state.fast=[0x0C,0x05];state.slow=[];setPollingMode("focused")');
  assert.equal(h.run('pollingMetadata().mode'),'dashboard');
  await h.run('pollLoop()');
  assert.deepEqual(seen,[0x0C,0x05,0x0C,0x05]);
});

test('paused PIDs produce no artificial samples and no adapter-voltage query flood', async t => {
  const h=harness();t.after(()=>h.close());let queries=0,volts=0;
  h.attach(async()=>{queries++;return null;},{supported:[0x13,0x14,0x15],sensorMask:3});
  h.run('setPollingMode("focused")');await h.click('btnRecordStart');
  await h.run('samplePid(0x14);');await h.run('samplePid(0x14)');
  await h.run('samplePid(0x15);');await h.run('samplePid(0x15)');
  h.context.testVoltage=()=>{volts++;return Promise.resolve(13.8);};
  h.context.setTimeout=(callback,delay)=>{
    assert.equal(delay,250);h.run('state.running=false');callback();return 0;
  };
  await h.run('elm.voltage=testVoltage;pollLoop()');
  assert.equal(queries,4);assert.equal(volts,0);
  assert.equal(h.run('recorder.session.samples.length'),4);
  assert.equal(h.run('recorder.session.counts.missing'),4);
});

test('sampling policy survives report and CSV export without changing older recordings', async t => {
  const h=harness();t.after(()=>h.close());
  h.attach(async pid=>bytesFor(pid),{supported,sensorMask:3});
  h.run('setPollingMode("focused")');await h.click('btnRecordStart');
  await h.run('samplePid(6)');await h.click('btnRecordStop');
  const before=h.run('JSON.stringify(recorder.session)');
  const exported=h.run('prepareDiagnosticExport(recorder.session)');h.context.exportedFixture=exported;
  assert.equal(exported.metadata.polling.mode,'focused');
  assert.match(h.run('diagnosticCsv(exportedFixture)'),/polling_mode.*polling_policy/);
  const header=h.run('diagnosticCsv(exportedFixture)').replace(/^\ufeff/,'').split('\r\n')[0].split(',').map(value=>JSON.parse(value));
  assert.equal(header.indexOf('recording_notes'),10);
  assert.equal(header.indexOf('response_including_queue_ms'),23);
  assert.deepEqual(header.slice(24),['polling_mode','polling_policy']);
  assert.match(h.run('diagnosticReportDocument(exportedFixture).html'),/Focused diagnostic: priority PIDs/);
  assert.equal(h.run('JSON.stringify(recorder.session)'),before);
});

test('fixed-latency scheduling model increases O2 coverage while continuing essential and general data', t => {
  const h=harness();t.after(()=>h.close());
  const pids=plain(h.run('new DemoTransport()._supported'));
  const fast=plain(h.run('FAST_PIDS')),slow=plain(h.run(`new DemoTransport()._supported.filter(pid=>PIDS[pid]&&!PIDS[pid].static&&!FAST_PIDS.includes(pid)&&pid!==1)`));
  function simulate(focused) {
    const plan=planner(pids,3),counts=new Map();let now=0,round=0,slowIndex=0;
    while(now<120000) {
      const batch=focused?plan.nextBatch(now):[...fast,slow[slowIndex++%slow.length]];
      for(const pid of batch) {
        if(now+303>120000)break;
        now+=303;counts.set(pid,(counts.get(pid)||0)+1);if(focused)plan.observe(pid,'valid',now);
      }
      if(++round%10===0)now+=303;now+=10;
    }
    return counts;
  }
  const original=simulate(false),focused=simulate(true);
  assert.ok(focused.get(0x14)>original.get(0x14)*10);
  assert.ok(focused.get(0x15)>original.get(0x15)*10);
  for(const pid of [0x0C,0x04,0x11,0x05,0x03,0x0D,0x0F])assert.ok(focused.get(pid)>0);
  t.diagnostic('120-second model at 303 ms/request: B1S1 '+original.get(0x14)+' default vs '+focused.get(0x14)+' focused results. Not a vehicle measurement.');
});

test('normal-delay demo keeps one command at a time, preserves recording/export, and reconnects in default mode', async t => {
  const h=harness({fastTimers:false});t.after(()=>h.close());
  h.run(`var focusCommands=[], focusActive=0, focusMaximum=0;
    const focusOriginalRequest=DemoTransport.prototype.request;
    DemoTransport.prototype.request=async function(command,timeout){
      focusCommands.push(command);focusActive++;focusMaximum=Math.max(focusMaximum,focusActive);
      try{return await focusOriginalRequest.call(this,command,timeout);}finally{focusActive--;}
    };`);
  await h.run('connect(true)');const connection=h.run('state.connection'),loopId=h.run('pollSession');
  const cut=h.run('focusCommands.length');h.run('setPollingMode("focused")');await h.click('btnRecordStart');
  await waitFor(()=>h.run('recorder.session.byPid[0x14]?.valid>=3&&recorder.session.byPid[0x15]?.valid>=3'),7000);
  await h.click('btnRecordStop');h.tick();
  assert.equal(h.run('state.connection'),connection);assert.equal(h.run('pollSession'),loopId);
  assert.equal(h.run('focusMaximum'),1);
  assert.equal(h.run('recorder.session.metadata.polling.mode'),'focused');
  assert.equal(h.run('recorder.session.source'),'demo');
  assert.ok(h.run('state.focusPlan.summary(performance.now()).find(s=>s.pid===0x14).rateHz>0'));
  assert.equal(h.run('recorder.session.counts.missing'),0);
  assert.equal(h.run('recorder.session.counts.failed'),0);
  assert.equal(h.run(`focusCommands.slice(${cut}).some(command=>command==='ATZ'||command==='04')`),false);
  const retained=h.run('recorder.session.samples.length');
  await h.run('connect(true)');
  assert.equal(h.run('state.pollingMode'),'dashboard');assert.equal(h.run('state.focusPlan'),null);
  assert.equal(h.run('recorder.session.samples.length'),retained);
  assert.equal(h.run('recorder.session.metadata.polling.mode'),'focused');
});
