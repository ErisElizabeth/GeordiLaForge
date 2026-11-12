'use strict';

class DiagnosticExports {
  constructor(getSession) {
    this.getSession = getSession; this.busy = false; this.readyDocument = null; this.downloadUrl = null;
    this.$ = id => document.querySelector('#' + id);
    this.$('btnExportReport').addEventListener('click', () => this.openReport());
    this.$('btnExportCsv').addEventListener('click', () => this.downloadCsv());
    this.$('btnReportPrint').addEventListener('click', () => {
      if (!this.readyDocument || this.readyDocument.documentElement.dataset.reportReady !== 'true') return;
      this.readyDocument.defaultView.focus(); this.readyDocument.defaultView.print();
    });
    this.$('btnReportClose').addEventListener('click', () => this.$('reportDialog').close());
    this.$('reportDialog').addEventListener('close', () => {
      this.readyDocument = null; this.$('btnReportPrint').disabled = true;
      this.$('reportFrame').srcdoc = '';
    });
    window.addEventListener('pagehide', () => {
      if (this.downloadUrl) URL.revokeObjectURL(this.downloadUrl);
      this.downloadUrl = null;
    });
  }

  update(session) {
    const disabled = this.busy || !diagnosticExportReady(session);
    this.$('btnExportReport').disabled = disabled;
    this.$('btnExportCsv').disabled = disabled;
  }

  snapshot() {
    return prepareDiagnosticExport(this.getSession(), {
      omitIdentifiers: this.$('exportOmitIdentifiers').checked,
      includeNotes: this.$('exportIncludeNotes').checked,
    });
  }

  async openReport() {
    if (this.busy) return;
    this.busy = true; this.update(this.getSession()); this.readyDocument = null;
    this.$('btnReportPrint').disabled = true;
    try {
      const exported = this.snapshot(), report = diagnosticReportDocument(exported);
      this.$('reportStatus').textContent = 'Preparing graphs and Letter-sized pages. Printing will be enabled when ready.';
      this.$('reportDialog').showModal();
      const frame = this.$('reportFrame');
      await new Promise((resolve, reject) => {
        frame.onload = resolve;
        frame.onerror = () => reject(new Error('The report preview could not load.'));
        frame.srcdoc = report.html;
      });
      if (!this.$('reportDialog').open) return;
      const doc = frame.contentDocument;
      const pages = await renderDiagnosticReport(doc, exported, report);
      if (!this.$('reportDialog').open || frame.contentDocument !== doc) return;
      this.readyDocument = doc;
      this.$('reportStatus').textContent = 'Ready: ' + pages + ' Letter pages. Choose Print / Save as PDF: Letter, 100% scale, browser headers/footers off. ' + diagnosticSourceNotice(exported.source);
      this.$('btnReportPrint').disabled = false;
      this.$('exportStatus').textContent = 'Report prepared from the stopped recording. Save the PDF before reloading the dashboard.';
    } catch (error) {
      this.$('exportStatus').textContent = error.message;
      this.$('reportStatus').textContent = error.message;
    } finally { this.busy = false; this.update(this.getSession()); }
  }

  downloadCsv() {
    if (this.busy) return;
    this.busy = true; this.update(this.getSession());
    try {
      const exported = this.snapshot(), csv = diagnosticCsv(exported);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      if (this.downloadUrl) URL.revokeObjectURL(this.downloadUrl);
      this.downloadUrl = url;
      const link = document.createElement('a');
      link.href = url; link.download = diagnosticExportFilename(exported, 'csv');
      document.body.appendChild(link); link.click(); link.remove();
      // Retain at most one CSV Blob until the next export or page close. A timer
      // must not invalidate a download while the operator is in a Save As dialog.
      this.$('exportStatus').textContent = 'CSV download requested: ' + exported.samples.length + ' recorded results, plus one recording metadata row. ' +
        'Formula-like text is prefixed with an apostrophe for spreadsheet safety; numeric negative measurements are unchanged.';
    } catch (error) { this.$('exportStatus').textContent = error.message; }
    finally { this.busy = false; this.update(this.getSession()); }
  }
}
