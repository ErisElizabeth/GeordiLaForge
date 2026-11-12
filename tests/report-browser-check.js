'use strict';

// Optional development QA using the bundled Playwright and installed Chrome.
// No app transport is loaded. An isolated headless context renders only synthetic
// report HTML in memory; all network requests are blocked. No persistent profile.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { recordedSession } = require('./export-fixtures.js');
const { chromium } = require(process.env.GEORDI_PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(__dirname, '..');
const directory = process.env.GEORDI_REPORT_QA_DIR;
if (!directory) throw new Error('Set GEORDI_REPORT_QA_DIR to a temporary PDF QA directory.');
fs.mkdirSync(directory, {recursive:true});
const names = ['dtc-db.js', 'graphs.js', 'exports.js', 'report.js', 'export-ui.js'];
const source = names.map(name => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');
const context = vm.createContext({structuredClone});
vm.runInContext(source, context);
const api = vm.runInContext('({prepareDiagnosticExport,diagnosticReportDocument})', context);

(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.GEORDI_CHROME_PATH || undefined,
    args:['--disable-background-networking','--disable-extensions']});
  try {
    const browserContext = await browser.newContext({acceptDownloads:true});
    let requests = 0;
    await browserContext.route('**/*', route => { requests++; return route.abort(); });
    const cases = [
      {name:'short-redacted', session:recordedSession(20)},
      {name:'long-simulated', session:recordedSession(20000)},
      {name:'empty-simulated', session:recordedSession(0)},
    ];
    cases[0].session.notes += '\nVIN KNDJF724X77012345\n<img src="https://invalid.example/leak" onerror="alert(1)">';
    cases[0].session.samples[1] = {...cases[0].session.samples[1],value:null,quality:'missing',reason:'NO DATA or timeout'};
    cases[0].session.samples[2] = {...cases[0].session.samples[2],value:null,quality:'failed',reason:'Truncated payload'};
    cases[1].session.notes = ('Warm idle. Observed conditions only, "no conclusions".\n').repeat(70).slice(0,4000);
    cases[2].session.metadata = {};
    const manifest = [];
    for (const item of cases) {
      const page = await browserContext.newPage();
      await page.evaluate(code => {
        window.reportApi = new Function(code + '\nreturn {renderDiagnosticReport,DiagnosticExports};')();
      }, source);
      const exported = api.prepareDiagnosticExport(item.session, {includeNotes:true}), report = api.diagnosticReportDocument(exported);
      const before = JSON.stringify(item.session);
      await page.setContent(report.html);
      const pages = await page.evaluate(async payload => {
        return window.reportApi.renderDiagnosticReport(document, payload.exported, payload.report);
      }, {exported, report});
      const layout = await page.evaluate(() => ({ready:document.documentElement.dataset.reportReady,
        warnings:[...document.querySelectorAll('.source-warning')].map(n=>n.textContent),
        overflow:[...document.querySelectorAll('.page-body')].map(n=>n.scrollHeight-n.clientHeight),
        canvases:[...document.querySelectorAll('canvas')].map(n=>({width:n.width,height:n.height})),
        text:document.body.innerText}));
      assert.equal(layout.ready, 'true');
      assert.equal(layout.warnings.length, pages);
      assert.ok(layout.warnings.every(text => text.includes('SIMULATED DATA')));
      assert.ok(layout.overflow.every(value => value <= 1), JSON.stringify(layout.overflow));
      assert.equal(layout.canvases.length, 5);
      assert.ok(layout.canvases.every(canvas => canvas.width >= 1400 && canvas.height === 560));
      assert.equal(layout.text.includes(item.session.metadata.vin || '__absent_vin__'), false);
      const filename = path.join(directory, item.name + '.pdf');
      await page.pdf({path:filename,format:'Letter',preferCSSPageSize:true,printBackground:false,displayHeaderFooter:false});
      assert.equal(JSON.stringify(item.session), before);
      manifest.push({name:item.name,filename,pages,samples:item.session.samples.length});
      await page.close();
    }
    // Exercise the real preview controller, iframe load, print readiness, and
    // completed-session CSV download, without ever loading app.js or obd.js.
    const ui = await browserContext.newPage();
    await ui.setContent('<button id="btnExportReport">Export Report</button><button id="btnExportCsv">Export CSV</button>' +
      '<input id="exportOmitIdentifiers" type="checkbox" checked><input id="exportIncludeNotes" type="checkbox">' +
      '<p id="exportStatus"></p><dialog id="reportDialog"><p id="reportStatus"></p>' +
      '<button id="btnReportPrint" disabled>Print</button><button id="btnReportClose">Close</button>' +
      '<iframe id="reportFrame" style="width:800px;height:600px"></iframe></dialog>');
    await ui.evaluate(({code,recording}) => {
      const api = new Function(code + '\nreturn {DiagnosticExports};')();
      window.controller = new api.DiagnosticExports(() => recording); window.controller.update(recording);
    }, {code:source,recording:recordedSession(20)});
    await ui.click('#btnExportReport');
    await ui.waitForFunction(() => !document.querySelector('#btnReportPrint').disabled);
    assert.match(await ui.locator('#reportStatus').innerText(), /Ready:.*SIMULATED DATA/);
    const iframeReady = await ui.locator('#reportFrame').evaluate(frame => frame.contentDocument.documentElement.dataset.reportReady);
    assert.equal(iframeReady, 'true');
    await ui.click('#btnReportClose');
    const downloadPromise = ui.waitForEvent('download'); await ui.click('#btnExportCsv');
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /^geordi-simulated-/);
    const downloadedPath = path.join(directory, 'downloaded-simulated.csv');
    const downloadFailure = await download.failure();
    if (!downloadFailure) {
      await download.saveAs(downloadedPath);
      assert.match(fs.readFileSync(downloadedPath,'utf8'), /SIMULATED DATA/);
    }
    assert.equal(requests, 0);
    fs.writeFileSync(path.join(directory,'manifest.json'), JSON.stringify(manifest,null,2));
    console.log(JSON.stringify({reports:manifest,previewReady:true,csvDownloadStarted:true,
      csvDownloadSaved:!downloadFailure,csvDownloadFailure:downloadFailure,networkRequests:requests},null,2));
    await browserContext.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
