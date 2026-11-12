'use strict';

// Optional native-browser QA. Loads only this local app's code and DemoTransport
// in an isolated context with Bluetooth removed and network requests intercepted.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.GEORDI_PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(__dirname,'..');
const output = process.env.GEORDI_POLLING_QA_DIR;
if (!output) throw new Error('Set GEORDI_POLLING_QA_DIR to a temporary screenshot directory.');
fs.mkdirSync(output,{recursive:true});
const originalHtml = fs.readFileSync(path.join(root,'index.html'),'utf8');
const scripts = [...originalHtml.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match=>match[1]);
let html = originalHtml.replace(/<script src="[^"]+"><\/script>/g,'').replace(/<link rel="stylesheet" href="style.css">/,
  '<style>'+fs.readFileSync(path.join(root,'style.css'),'utf8')+'</style>');
html = html.replace('src="assets/GeordiLaForge.jfif"',
  'src="data:image/jpeg;base64,'+fs.readFileSync(path.join(root,'assets','GeordiLaForge.jfif')).toString('base64')+'"');

(async()=>{
  const browser = await chromium.launch({headless:true,executablePath:process.env.GEORDI_CHROME_PATH || undefined});
  try {
    const context = await browser.newContext({viewport:{width:1280,height:960}});
    let unexpectedRequests=0;
    await context.route('**/*',route=>{
      if(route.request().url()==='http://geordi.test/')return route.fulfill({status:200,contentType:'text/html',body:html});
      unexpectedRequests++;return route.abort();
    });
    await context.addInitScript(()=>{
      Object.defineProperty(navigator,'bluetooth',{value:undefined,configurable:true});
      window.Audio=function(){return {currentTime:0,play:async()=>{}};};
    });
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto('http://geordi.test/');
    for(const file of scripts)await page.addScriptTag({content:fs.readFileSync(path.join(root,file),'utf8')});
    assert.equal(await page.locator('#pollingMode').isDisabled(),true);
    await page.click('#btnDemo');
    await page.waitForFunction(()=>state.running&&!state.busy);
    const baseline=await page.evaluate(()=>{
      window.focusTrace=[];window.focusInFlight=0;window.focusMaximum=0;
      const original=transport.request.bind(transport);
      transport.request=async(command,timeout)=>{
        focusTrace.push(command);focusInFlight++;focusMaximum=Math.max(focusMaximum,focusInFlight);
        try{return await original(command,timeout);}finally{focusInFlight--;}
      };
      window.savedConnection=state.connection;window.savedLoop=pollSession;
      return state.pollingMode;
    });
    assert.equal(baseline,'dashboard');
    await page.selectOption('#pollingMode','focused');
    await page.click('#btnRecordStart');
    await page.waitForFunction(()=>recorder.session.byPid[0x14]?.valid>=3&&recorder.session.byPid[0x15]?.valid>=3);
    assert.equal(await page.locator('#pollingMode').isDisabled(),true);
    await page.click('#btnRecordStop');
    await page.locator('#focusedSampling > summary').click();
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(output,'focused-desktop.png')});
    const evidence=await page.evaluate(()=>({
      sameConnection:state.connection===savedConnection,sameLoop:pollSession===savedLoop,
      maximum:focusMaximum,source:recorder.session.source,mode:recorder.session.metadata.polling.mode,
      oxygen:recorder.summary().series.filter(s=>s.pid===0x14||s.pid===0x15).map(s=>({pid:s.pid,count:s.valid,rateHz:s.rateHz})),
      commandsSafe:focusTrace.every(c=>c.startsWith('01')||c==='ATRV'),
      csvHasPolicy:diagnosticCsv(prepareDiagnosticExport(recorder.session)).includes('polling_policy'),
    }));
    assert.equal(evidence.sameConnection,true);assert.equal(evidence.sameLoop,true);
    assert.equal(evidence.maximum,1);assert.equal(evidence.source,'demo');assert.equal(evidence.mode,'focused');
    assert.equal(evidence.commandsSafe,true);assert.equal(evidence.csvHasPolicy,true);
    assert.ok(evidence.oxygen.every(item=>item.count>=3&&item.rateHz>0));
    await page.locator('#focusedSampling > summary').click();
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>window.scrollTo(0,0));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.screenshot({path:path.join(output,'focused-mobile.png')});
    await page.selectOption('#pollingMode','dashboard');
    assert.equal(await page.evaluate(()=>recorder.session.metadata.polling.mode),'focused');
    await page.setViewportSize({width:1280,height:960});
    await page.click('#btnExportReport');
    await page.waitForFunction(()=>!document.querySelector('#btnReportPrint').disabled);
    const report=await page.locator('#reportFrame').evaluate(frame=>({
      ready:frame.contentDocument.documentElement.dataset.reportReady,
      policy:frame.contentDocument.body.textContent.includes('Focused diagnostic: priority PIDs'),
      overflow:[...frame.contentDocument.querySelectorAll('.page-body')].some(body=>body.scrollHeight>body.clientHeight+1),
    }));
    assert.equal(report.ready,'true');assert.equal(report.policy,true);assert.equal(report.overflow,false);
    await page.screenshot({path:path.join(output,'focused-report-preview.png')});
    await page.click('#btnReportClose');await page.click('#btnConnect');
    assert.equal(await page.evaluate(()=>state.running),false);
    assert.deepEqual(errors,[]);assert.equal(unexpectedRequests,0);
    console.log(JSON.stringify({evidence,report,desktopAndMobile:true,javascriptErrors:errors,
      unexpectedNetworkRequests:unexpectedRequests},null,2));
    await context.close();
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
