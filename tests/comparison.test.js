'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {loadFiles, harness, plain, waitFor} = require('./helpers.js');

const full = [1,3,4,5,6,7,8,9,0x0C,0x0D,0x10,0x11,0x13,0x14,0x15,0x18,0x19,0x42,0xA6];
const bytes = pid => pid === 0x13 ? [0x33] : pid === 0x1D ? [0x0F]
  : pid === 0x0C ? [0x0F,0xA0] : pid >= 0x14 && pid <= 0x1B ? [100,255]
    : pid === 3 ? [2,0] : [120];
function fixture(pids = full, layout = 0x13, mask = 0x33, validated = true) {
  const c = vm.createContext({structuredClone});
  loadFiles(c, ['pids.js','capabilities.js','polling.js','dtc-db.js','obd.js','graphs.js','exports.js','report.js']);
  const api = vm.runInContext('({EcuCapabilities,ComparisonPollingPlan,FocusedPollingPlan,decodePidReading,oxygenLocation,Elm,diagnosticGraphSpecs,TelemetryGraphIndex,buildDiagnosticGraph,diagnosticGraphRange,prepareDiagnosticExport,diagnosticCsv,diagnosticReportDocument})', c);
  const cap = new api.EcuCapabilities(new Set(pids));
  if (layout !== null) cap.observe(layout, api.decodePidReading(layout,[mask]), [mask]);
  if (validated) for (const pid of pids) if (pid !== layout) cap.observe(pid, api.decodePidReading(pid,bytes(pid)),bytes(pid));
  return {...api, cap, c};
}
function plan(f, profile = 'oxygen-comparison') { return new f.ComparisonPollingPlan(profile,f.cap); }

test('passive inventory separates advertisements, decoder availability, observations and profile suitability', () => {
  const f = fixture(full,0x13,0x33,false), cap = f.cap;
  assert.equal(cap.classify(6).classification,'Supported and decoded');
  assert.equal(cap.classify(6).decodedSuccessfully,false);
  assert.match(cap.classify(6).suitability,/Awaiting/);
  assert.equal(cap.classify(0xA6).classification,'Supported; decoder unavailable');
  assert.equal(cap.classify(0x0A).classification,'Not advertised by ECU');
  assert.equal(cap.classify(1).decoded,true);
  assert.match(cap.classify(0x13).suitability,/Static/);
  cap.observe(6,f.decodePidReading(6,[120]),[120],100,303);
  cap.observe(6,{quality:'missing',reason:'NO DATA'},null,1000,420);
  assert.equal(cap.success(6),true);
  assert.equal(cap.classify(6).lastQuality,'missing');
  assert.equal(cap.classify(6).reason,'NO DATA');
  assert.equal(cap.classify(6).responseMs,420);
  cap.observe(0x0A,{quality:'valid',value:3});
  assert.equal(cap.success(0x0A),false);
  assert.ok(cap.rows(true).length>cap.rows().length);
  const snapshot=cap.snapshot();snapshot.find(row=>row.pid===0x14).location.bank=99;
  assert.equal(cap.location(0x14).bank,1);
});

test('existing straightforward parameter decoders remain available with native values', () => {
  const f=fixture();
  for(const [pid,payload,value] of [[0x42,[0x35,0xE8],13.8],[0x0A,[100],300],[0x0B,[42],42],
    [0x10,[1,244],5],[0x1F,[0,60],60],[0x3C,[0x11,0xF8],420],[0x44,[0x80,0],1],
    [0x30,[14],14],[0x31,[0,100],100]]) {
    const reading=f.decodePidReading(pid,payload);
    assert.equal(reading.quality,'valid');assert.equal(reading.value,value);
  }
});

test('standard and alternative sensor layouts map actual bank positions, with absent bits excluded', () => {
  const standard=fixture();
  assert.deepEqual(plain(standard.cap.location(0x18)),{bank:2,sensor:1,layoutPid:0x13});
  assert.equal(standard.cap.location(0x16),null);
  const pids=full.filter(pid=>pid!==0x13).concat(0x1D,0x16,0x17);
  const alternative=fixture(pids,0x1D,0x3F);
  assert.deepEqual(plain(alternative.cap.location(0x16)),{bank:2,sensor:1,layoutPid:0x1D});
  assert.deepEqual(plain(alternative.cap.location(0x18)),{bank:3,sensor:1,layoutPid:0x1D});
  assert.deepEqual(plain(plan(alternative).targets),[0x14,0x16,0x15,0x17]);
});

test('absent, conflicting, missing and invalid layout responses cannot verify oxygen locations', () => {
  for (const f of [fixture(full,null,0,false),fixture(full.concat(0x1D)),fixture(full,0x13,0),fixture(full,0x13,0x33,false)]) {
    if(f.cap.masks[0x13]===0x33 && !f.cap.supported.has(0x1D)) f.cap.masks={};
    assert.equal(f.cap.location(0x14),null);
    assert.equal(plan(f).active,false);
    assert.match(f.cap.classify(0x14).suitability,/unverified/);
  }
  const f=fixture(full,null,0,false);
  f.cap.observe(0x13,f.decodePidReading(0x13,[]),[]);
  assert.equal(f.cap.location(0x14),null);
});

test('support bitmap walk follows only advertised continuation, including beyond PID 80', async () => {
  const f=fixture(), calls=[];const elm=new f.Elm({},()=>{});
  elm.pid01=async(pid,timeout)=>{calls.push([pid,timeout]);return [0x80,0,0,pid<0xA0?1:0];};
  const pids=await elm.supportedPids();
  assert.deepEqual(calls.map(call=>call[0]),[0,0x20,0x40,0x60,0x80,0xA0]);
  assert.deepEqual([...pids],[1,0x21,0x41,0x61,0x81,0xA1]);
  assert.equal(calls[0][1],20000);assert.ok(calls.slice(1).every(call=>call[1]===8000));
  calls.length=0;elm.pid01=async pid=>{calls.push(pid);return [0,0,0,0];};
  assert.equal((await elm.supportedPids()).size,0);assert.deepEqual(calls,[0]);
});

test('support discovery terminates on malformed responses and never goes beyond an eight-bit PID', async () => {
  const f=fixture(), elm=new f.Elm({},()=>{}),calls=[];
  elm.pid01=async pid=>{calls.push(pid);return pid===0?[0,0,0,1]:[0,0];};
  await elm.supportedPids();assert.deepEqual(calls,[0,0x20]);
  calls.length=0;elm.pid01=async pid=>{calls.push(pid);return [0,0,0,1];};
  await elm.supportedPids();assert.equal(calls.at(-1),0xE0);assert.equal(calls.length,8);
});

test('comparison eligible pool requires successful decoding; one advertised candidate is validated per round', () => {
  const f=fixture(full,0x13,0x33,false),p=plan(f);
  assert.deepEqual(plain(p.nextBatch(0)),[]);
  const first=p.nextValidation(0);assert.ok(p.targets.includes(first));assert.equal(p.eligible(first,0),false);
  f.cap.observe(first,f.decodePidReading(first,[100]),[100]); // truncated O2 response
  p.observe(first,'failed',303);
  assert.equal(f.cap.success(first),false);assert.equal(p.eligible(first,304),false);
  f.cap.observe(first,f.decodePidReading(first,bytes(first)),bytes(first));p.observe(first,'valid',606);
  assert.equal(p.eligible(first,607),true);assert.deepEqual(plain(p.nextBatch(607)),[first]);
  assert.notEqual(p.nextValidation(607),first);
  assert.equal(p.candidates.includes(0xA6),false);assert.equal(p.candidates.includes(0x42),false);
});

test('pending validation failures use the existing backoff, recover, and never block the other bank', () => {
  const f=fixture(full,0x13,0x33,false),p=plan(f),pid=0x18;
  f.cap.observe(0x14,f.decodePidReading(0x14,bytes(0x14)),bytes(0x14));
  for(const time of [303,606]) {f.cap.observe(pid,{quality:'missing',reason:'NO DATA'});p.observe(pid,'missing',time);}
  assert.equal(p.canValidate(pid,15605),false);assert.equal(p.canValidate(pid,15606),true);
  for(let i=0;i<10;i++){assert.ok(p.nextBatch(1000).includes(0x14));assert.notEqual(p.nextValidation(1000),pid);}
  f.cap.observe(pid,f.decodePidReading(pid,bytes(pid)),bytes(pid));p.observe(pid,'valid',16000);
  assert.equal(p.eligible(pid,16001),true);assert.equal(p.health.get(pid).consecutiveFailures,0);
});

test('comparison target order rotates fairly across banks, with occasional core conditions and lower-rate oxygen RPM', () => {
  const f=fixture(),p=plan(f),counts=new Map(),leads=new Set();
  for(let round=0;round<32;round++) {
    const batch=p.nextBatch(round*2000);leads.add(batch[0]);
    assert.equal(batch.length,new Set(batch).size);
    batch.forEach(pid=>counts.set(pid,(counts.get(pid)||0)+1));
  }
  assert.deepEqual([...leads].sort((a,b)=>a-b),[0x14,0x15,0x18,0x19]);
  for(const pid of p.targets)assert.equal(counts.get(pid),32);
  assert.equal(counts.get(0x0C),16);
  for(const pid of [3,4,5,0x11])assert.equal(counts.get(pid),2);
  assert.equal(counts.has(0x42),false);
  const trim=plan(f,'trim-comparison');assert.deepEqual(plain(trim.targets),[6,8,7,9]);
  for(let i=0;i<8;i++)assert.ok(trim.nextBatch(i).includes(0x0C));
});

test('partial ECU support explains missing comparison targets without requesting them', () => {
  const f=fixture([0x13,0x14,0x15,6,7,0x0C],0x13,3),o=plan(f),tr=plan(f,'trim-comparison');
  assert.equal(o.excluded.length,2);assert.equal(tr.excluded.length,2);
  for(let i=0;i<12;i++){assert.ok(o.nextBatch(i).every(pid=>[0x14,0x15,0x0C].includes(pid)));
    assert.ok(tr.nextBatch(i).every(pid=>[6,7,0x0C].includes(pid)));}
  const none=fixture([0x0C,5],null);assert.equal(plan(none).active,false);
  assert.match(plan(none).description(),/Dashboard default schedule used/);
});

test('intermittent sensors retain valid evidence while M4 retry pauses and recovery apply', () => {
  const f=fixture(),p=plan(f);
  for(const time of [303,606]){f.cap.observe(0x18,{quality:'missing',reason:'NO DATA'});p.observe(0x18,'missing',time);}
  assert.equal(f.cap.success(0x18),true);assert.equal(p.nextBatch(1000).includes(0x18),false);
  assert.ok(p.nextBatch(1000).includes(0x19));
  p.observe(0x18,'failed',15606);assert.equal(p.health.get(0x18).eligibleAt,45606);
  p.observe(0x18,'failed',45606);assert.equal(p.health.get(0x18).eligibleAt,105606);
  p.observe(0x18,'valid',105606);assert.equal(p.eligible(0x18,105607),true);
  const stats=p.summary(105910).find(row=>row.pid===0x18);
  assert.equal(stats.missing,2);assert.equal(stats.failed,2);assert.equal(stats.ageMs,304);
});

test('303 ms constrained model compares bank coverage with M4 and continues every core condition', t => {
  const f=fixture();
  function simulate(p) {
    const counts=new Map();let now=0,round=0;
    while(now<120000) {
      for(const pid of p.nextBatch(now)) {
        if(now+303>120000)break;now+=303;counts.set(pid,(counts.get(pid)||0)+1);p.observe(pid,'valid',now);
      }
      if(++round%10===0 && p instanceof f.FocusedPollingPlan && !(p instanceof f.ComparisonPollingPlan))now+=303;
      now+=10;
    }return counts;
  }
  const baseline=simulate(new f.FocusedPollingPlan(new Set(full),0x33));
  const oxygen=simulate(plan(f)),trim=simulate(plan(f,'trim-comparison'));
  for(const pid of [0x14,0x15])assert.ok(oxygen.get(pid)>baseline.get(pid));
  for(const pid of [0x18,0x19])assert.ok(oxygen.get(pid)>baseline.get(pid)*5);
  for(const pid of [6,7,8,9])assert.ok(trim.get(pid)>baseline.get(pid));
  assert.ok(Math.abs(oxygen.get(0x14)-oxygen.get(0x18))<=1);
  assert.ok(Math.abs(trim.get(6)-trim.get(8))<=1);
  for(const pid of [0x0C,3,4,5,0x11]){assert.ok(oxygen.get(pid)>0);assert.ok(trim.get(pid)>0);}
  t.diagnostic(JSON.stringify({modelOnly:true,msPerRequest:303,durationSeconds:120,
    M4:Object.fromEntries(baseline),oxygen:Object.fromEntries(oxygen),trims:Object.fromEntries(trim)}));
});

test('comparison selection and provenance are frozen at start; exports preserve all results and CSV compatibility', async t => {
  const h=harness();t.after(()=>h.close());h.attach(async pid=>bytes(pid),{supported:full,sensorMask:0x33});
  assert.equal(h.run('setPollingMode("oxygen-comparison")'),true);
  const identity=h.run('state.connection');assert.equal(h.run('state.focusPlan.eligible(0x18,performance.now())'),false);
  await h.click('btnRecordStart');
  assert.equal(h.run('setPollingMode("trim-comparison")'),false);
  await h.run('samplePid(0x18)');await h.run('samplePid(0x14)');
  assert.equal(h.run('state.focusPlan.eligible(0x18,performance.now())'),true);
  assert.equal(h.run('recorder.session.metadata.capabilities.find(row=>row.pid===0x18).decodedSuccessfully'),false);
  await h.click('btnRecordStop');const before=h.run('JSON.stringify(recorder.session)');
  assert.equal(h.run('setPollingMode("trim-comparison")'),true);
  assert.equal(h.run('state.connection'),identity);
  assert.equal(h.run('JSON.stringify(recorder.session)'),before);
  const exported=h.run('prepareDiagnosticExport(recorder.session)');h.context.savedExport=exported;
  assert.equal(exported.metadata.polling.mode,'oxygen-comparison');assert.equal(exported.samples.length,2);
  assert.equal(exported.metadata.measurements.find(row=>row.pid===0x18).bank,2);
  assert.equal(exported.metadata.measurements.find(row=>row.pid===0x18).layoutPid,0x13);
  const csv=h.run('diagnosticCsv(savedExport)'),header=csv.replace(/^\ufeff/,'').split('\r\n')[0].split(',').map(JSON.parse);
  assert.equal(header.length,26);assert.deepEqual(header.slice(24),['polling_mode','polling_policy']);
  assert.match(csv,/oxygen-comparison/);assert.match(csv,/O2 B2S1 voltage/);
  const report=h.run('diagnosticReportDocument(savedExport)');assert.equal(report.models[0].id,'oxygen-upstream');
  assert.match(report.html,/Oxygen Sensor Comparison/);assert.match(report.html,/B2S1/);
  assert.equal(h.run('state.focusPlan.latency.size'),0); // new profile starts fresh statistics
});

test('alternative layout graphs and exports use saved mapping and preserve sequential timestamps and failures', async t => {
  const h=harness();t.after(()=>h.close());const pids=[0x1D,0x14,0x15,0x16,0x17,0x18,6,8];
  h.attach(async pid=>pid===0x17?null:bytes(pid),{supported:pids});
  h.run('ensureCapabilities().masks[0x1D]=0x3F;setPollingMode("oxygen-comparison")');
  await h.click('btnRecordStart');for(const pid of [0x14,0x16,0x17])await h.run('samplePid('+pid+')');
  await h.click('btnRecordStop');
  const data=h.run('prepareDiagnosticExport(recorder.session)');h.context.savedExport=data;
  const report=h.run('diagnosticReportDocument(savedExport)');
  assert.deepEqual(plain(report.models[0].pids),[0x14,0x16]);
  assert.deepEqual(plain(report.models[1].pids),[0x15,0x17]);
  assert.equal(report.models[0].series[1].label,'B2S1 · upstream');
  assert.equal(report.models[1].series[1].missing,1);
  assert.ok(data.samples[1].elapsedMs>data.samples[0].elapsedMs);
  assert.match(h.run('diagnosticCsv(savedExport)'),/NO DATA/);
  assert.match(h.run('recordingLabel(0x18).label'),/B3S1/);
  assert.equal(report.models.flatMap(model=>model.pids).includes(0x18),false);
});

test('unverified or absent banks stay explicitly unavailable in graphs, reports and empty recordings', async t => {
  const h=harness();t.after(()=>h.close());h.attach(async()=>[100,255],{supported:[0x13,0x14,6],sensorMask:1});
  h.run('setPollingMode("oxygen-comparison")');await h.click('btnRecordStart');await h.click('btnRecordStop');
  const report=h.run('diagnosticReportDocument(prepareDiagnosticExport(recorder.session))');
  assert.equal(report.models[0].series[1].pid,null);assert.equal(report.models[0].series[1].entries.length,0);
  assert.match(report.models[0].series[1].availability,/No verified/);assert.match(report.html,/EMPTY RECORDING/);
  assert.match(report.html,/PID unavailable/);
  h.run('diagnosticGraphs.refresh()');assert.equal(h.node('panel-oxygen').hidden,true);
  assert.equal(h.node('panel-oxygen-upstream').hidden,false);
});

test('trim profile graphs retain negative observations, missing Bank 2 results and privacy defaults', async t => {
  const h=harness();t.after(()=>h.close());h.attach(async pid=>pid===9?null:[120],{supported:[6,7,8,9]});
  h.run('state.vehicle.vin="KNDJF724X77012345";setPollingMode("trim-comparison")');
  h.node('recordingNotes').value='Private notes, "text"\n=FORMULA';await h.click('btnRecordStart');
  for(const pid of [6,7,8,9])await h.run('samplePid('+pid+')');await h.click('btnRecordStop');
  const report=h.run('diagnosticReportDocument(prepareDiagnosticExport(recorder.session))');
  assert.equal(report.models[0].id,'trims-short');assert.equal(report.models[1].id,'trims-long');
  assert.ok(report.models[0].series.every(series=>series.entries[0].sample.value<0));
  assert.equal(report.models[1].series[1].missing,1);
  assert.equal(report.html.includes('KNDJF724X77012345'),false);assert.equal(report.html.includes('Private notes'),false);
  assert.match(report.html,/Fuel Trim Comparison/);
});

test('dual-bank Demo integration keeps one queue and loop, actual latency, and no hot-path adapter queries', async t => {
  const h=harness();t.after(()=>h.close());
  h.run(`var compareTrace=[],compareActive=0,compareMaximum=0;
    const priorConnect=DemoTransport.prototype.connect,priorBytes=DemoTransport.prototype._pidBytes,priorRequest=DemoTransport.prototype.request;
    DemoTransport.prototype.connect=async function(log){this._supported.push(8,9,0x18,0x19);await priorConnect.call(this,log);};
    DemoTransport.prototype._pidBytes=function(pid){return pid===0x13?[0x33]:[8,9].includes(pid)?[120]:[0x18,0x19].includes(pid)?[100,255]:priorBytes.call(this,pid);};
    DemoTransport.prototype.request=async function(command,timeout){compareTrace.push(command);compareActive++;compareMaximum=Math.max(compareMaximum,compareActive);
      try{return await priorRequest.call(this,command,timeout);}finally{compareActive--;}};`);
  await h.run('connect(true)');const connection=h.run('state.connection'),loop=h.run('pollSession');
  h.run('setPollingMode("oxygen-comparison")');await h.click('btnRecordStart');
  await waitFor(()=>h.run('[0x14,0x15,0x18,0x19].every(pid=>recorder.session.byPid[pid]?.valid>=3)'));
  await h.click('btnRecordStop');h.tick();
  assert.equal(h.run('compareMaximum'),1);assert.equal(h.run('state.connection'),connection);assert.equal(h.run('pollSession'),loop);
  assert.equal(h.run('recorder.session.source'),'demo');
  const cut=h.run('compareTrace.length');
  await waitFor(()=>h.run(`compareTrace.length>${cut+20}`));
  assert.equal(h.run(`compareTrace.slice(${cut}).some(command=>!command.startsWith('01'))`),false);
  assert.ok(h.run('state.focusPlan.latency.get(0x18).last>0'));
  assert.equal(h.node('focusedSamplingRows').children[0].children.length,9);
  h.run('setPollingMode("trim-comparison")');await h.click('btnRecordStart');
  await waitFor(()=>h.run('[6,7,8,9].every(pid=>recorder.session.byPid[pid]?.valid>=3)'));
  await h.click('btnRecordStop');assert.equal(h.run('compareMaximum'),1);
  assert.equal(h.run('recorder.session.metadata.polling.mode'),'trim-comparison');
});
