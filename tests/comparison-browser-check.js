'use strict';

// Optional isolated browser QA. Only local source and mocked DemoTransport run;
// Web Bluetooth is absent and all external requests are blocked.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.GEORDI_PLAYWRIGHT_PATH || 'playwright');
const root=path.resolve(__dirname,'..'),output=process.env.GEORDI_COMPARISON_QA_DIR;
if(!output)throw new Error('Set GEORDI_COMPARISON_QA_DIR to a temporary output directory.');
fs.mkdirSync(output,{recursive:true});
const original=fs.readFileSync(path.join(root,'index.html'),'utf8');
const scripts=[...original.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match=>match[1]);
const html=original.replace(/<script src="[^"]+"><\/script>/g,'')
  .replace('<link rel="stylesheet" href="style.css">','<style>'+fs.readFileSync(path.join(root,'style.css'),'utf8')+'</style>')
  .replace('src="assets/GeordiLaForge.jfif"','src="data:image/jpeg;base64,'+fs.readFileSync(path.join(root,'assets','GeordiLaForge.jfif')).toString('base64')+'"');
const reportSource=['graphs.js','exports.js','dtc-db.js','report.js'].map(file=>fs.readFileSync(path.join(root,file),'utf8')).join('\n');

(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.GEORDI_CHROME_PATH || undefined,
    args:['--disable-background-networking','--disable-extensions']});
  try{
    const ctx=await browser.newContext({viewport:{width:1280,height:960}});let external=0;
    await ctx.route('**/*',route=>{
      if(route.request().url()==='http://geordi.test/')return route.fulfill({status:200,contentType:'text/html',body:html});
      external++;return route.abort();
    });
    await ctx.addInitScript(()=>{Object.defineProperty(navigator,'bluetooth',{value:undefined,configurable:true});
      window.Audio=function(){return {play:async()=>{},currentTime:0};};});
    const page=await ctx.newPage(),errors=[],manifest=[];page.on('pageerror',error=>errors.push(error.message));
    page.on('dialog',dialog=>dialog.accept());
    await page.goto('http://geordi.test/');for(const file of scripts)await page.addScriptTag({content:fs.readFileSync(path.join(root,file),'utf8')});
    await page.evaluate(()=>{
      const oldConnect=DemoTransport.prototype.connect,oldBytes=DemoTransport.prototype._pidBytes,oldRequest=DemoTransport.prototype.request;
      DemoTransport.prototype.connect=async function(log){this._supported.push(8,9,0x12,0x18,0x19);await oldConnect.call(this,log);};
      DemoTransport.prototype._pidBytes=function(pid){
        if(pid===0x13)return [0x33];if(pid===8)return [120];if(pid===9)return [126];
        if(pid===0x18){this._b2s1=(this._b2s1||0)+1;return this._b2s1%3===0?null:[100,255];}
        if(pid===0x19){this._b2s2=(this._b2s2||0)+1;return this._b2s2%4===0?[100]:[140,255];}
        return oldBytes.call(this,pid);
      };
      window.commands=[];window.inFlight=0;window.maximum=0;
      DemoTransport.prototype.request=async function(command,timeout){commands.push(command);inFlight++;maximum=Math.max(maximum,inFlight);
        try{return await oldRequest.call(this,command,timeout);}finally{inFlight--;}};
    });
    await page.click('#btnDemo');await page.waitForFunction(()=>state.running&&!state.busy);
    await page.evaluate(()=>{window.savedConnection=state.connection;window.savedLoop=pollSession;});
    for(const mode of ['oxygen-comparison','trim-comparison']){
      await page.selectOption('#pollingMode',mode);await page.click('#btnRecordStart');
      await page.waitForFunction(mode=>{
        const targets=mode==='oxygen-comparison'?[0x14,0x15,0x18,0x19]:[6,7,8,9];
        return targets.every(pid=>recorder.session.byPid[pid]?.valid>=4);
      },mode);
      await page.click('#btnRecordStop');
      await page.locator('#focusedSampling > summary').click();
      await page.locator('#samplingSection').screenshot({path:path.join(output,mode+'-rates.png')});
      await page.locator('#focusedSampling > summary').click();
      await page.locator('#capabilitiesDetails > summary').click();
      await page.waitForFunction(()=>document.querySelector('#capabilitiesRows').children.length>0);
      assert.match(await page.locator('#capabilitiesRows').innerText(),/decoder unavailable/);
      await page.selectOption('#capabilitiesFilter','references');
      assert.match(await page.locator('#capabilitiesRows').innerText(),/Not advertised/);
      await page.locator('#capabilitiesDetails > summary').click();
      const first=mode==='oxygen-comparison'?'oxygen-upstream':'trims-short';
      await page.locator('#panel-'+first).screenshot({path:path.join(output,mode+'-desktop.png')});
      await page.click('#next-'+first);assert.match(await page.locator('#inspect-'+first).innerText(),/elapsed|Elapsed/);
      await page.selectOption('#graphRange','custom');await page.fill('#graphFrom','0.1');
      await page.fill('#graphTo','1.2');await page.click('#graphApplyRange');
      assert.match(await page.locator('#graphWindow').innerText(),/0.100–1.200/);
      await page.selectOption('#graphRange','all');
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.locator('#panel-'+first).screenshot({path:path.join(output,mode+'-mobile.png')});
      await page.setViewportSize({width:1280,height:960});
      const evidence=await page.evaluate(()=>({sameConnection:state.connection===savedConnection,sameLoop:pollSession===savedLoop,
        maximum,mode:recorder.session.metadata.polling.mode,counts:recorder.session.counts,
        series:recorder.summary().series.map(s=>({pid:s.pid,valid:s.valid,rateHz:s.rateHz})),
        exported:prepareDiagnosticExport(recorder.session),csv:diagnosticCsv(prepareDiagnosticExport(recorder.session))}));
      assert.equal(evidence.sameConnection,true);assert.equal(evidence.sameLoop,true);assert.equal(evidence.maximum,1);
      assert.equal(evidence.mode,mode);assert.match(evidence.csv,/SIMULATED DATA/);
      fs.writeFileSync(path.join(output,mode+'.csv'),evidence.csv);
      await page.click('#btnExportReport');await page.waitForFunction(()=>!document.querySelector('#btnReportPrint').disabled);
      assert.equal(await page.locator('#reportFrame').evaluate(frame=>frame.contentDocument.documentElement.dataset.reportReady),'true');
      await page.click('#btnReportClose');
      // Verify native print output using the same renderer as the actual preview.
      const pdf=await ctx.newPage();await pdf.setContent('<html></html>');
      const report=await pdf.evaluate(({code,exported})=>{
        const api=new Function(code+'\nreturn {diagnosticReportDocument};')();return api.diagnosticReportDocument(exported);
      },{code:reportSource,exported:evidence.exported});
      await pdf.setContent(report.html);
      const pages=await pdf.evaluate(async({code,report,exported})=>{
        const api=new Function(code+'\nreturn {renderDiagnosticReport};')();
        return api.renderDiagnosticReport(document,exported,report);
      },{code:reportSource,report,exported:evidence.exported});
      const layout=await pdf.evaluate(()=>({warnings:[...document.querySelectorAll('.source-warning')].map(n=>n.textContent),
        overflow:[...document.querySelectorAll('.page-body')].some(n=>n.scrollHeight>n.clientHeight+1)}));
      assert.equal(layout.overflow,false);assert.equal(layout.warnings.length,pages);
      assert.ok(layout.warnings.every(text=>text.includes('SIMULATED DATA')));
      await pdf.pdf({path:path.join(output,mode+'.pdf'),format:'Letter',preferCSSPageSize:true,printBackground:false});
      manifest.push({mode,pages,counts:evidence.counts,series:evidence.series});await pdf.close();
    }
    assert.equal(await page.evaluate(()=>maximum),1);assert.deepEqual(errors,[]);assert.equal(external,0);
    await page.click('#btnConnect');console.log(JSON.stringify({manifest,javascriptErrors:errors,externalRequests:external},null,2));
    await ctx.close();
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
