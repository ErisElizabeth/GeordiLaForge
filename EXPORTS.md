# Recording exports

Stop a diagnostic recording before selecting **Export Report** or **Export CSV**.
Exports use an independent copy of the entire stopped recording. They do not
change the recording, use the selected dashboard graph window, or request vehicle
data. Recordings and previews are held in memory; export before reloading.

## Privacy

Vehicle identifier omission is on by default. Operator notes are off by default;
select their inclusion after reviewing them for identifying information. Known
identifier values and VIN-like strings are redacted from included text when
omission is enabled. Arbitrary personal information in notes cannot be detected
reliably. Export filenames never contain the VIN.

## Report and PDF

The report has its own preview. Wait for **Ready**, then choose **Print / Save as
PDF**. Use US Letter paper, 100% scale, and turn off the browser's optional
headers/footers. Application page headers and page numbers are already included.
Simulation warnings are ordinary printed text on every page and do not depend
on the print-backgrounds setting. The report uses the existing Canvas renderer,
with a fixed high-contrast print palette and a complete-recording time range.

VIN and protocol are recording metadata snapshots. DTCs are available only when
the existing **Re-read** action finishes within the same active recording. An
export never triggers that action. Older recordings without a DTC snapshot show
unavailable codes. Empty decoded DTC results are explicitly inconclusive because
the existing parser cannot verify response quality for those results.

Report figures show individual observations, gaps, and data quality. Summary
numbers are rounded to at most three decimal places; CSV retains recorded numeric
values. Sparse O2 sampling is unchanged and does not establish converter failure.

## CSV schema

The UTF-8 CSV starts with a header and one `row_type=recording` metadata row. That
row holds operator notes if selected. Each subsequent `row_type=sample` row is
one original observation, including PIDs outside the diagnostic graphs. Filter
on `row_type=sample` for numeric analysis. Every row identifies the session and
data source, including an explicit simulation warning for demo data.
New recordings also export `polling_mode` and `polling_policy`; their report
boundary table includes the sampling policy selected before recording. These
fields stay empty for older recordings that did not capture a policy.

Samples include receipt and queue timestamps, elapsed times, PID, measurement
name, value, native unit, quality, failure explanation and sensor-location status.
Missing/failed values remain empty. Text fields use standard CSV quoting; text
that could be evaluated as a spreadsheet formula is prefixed with an apostrophe.
Real numeric negative measurements remain numeric. No values are interpolated.

## Development verification

Run the dependency-free tests with:

```powershell
node --test tests/*.test.js
```

`tests/report-browser-check.js` is optional PDF/preview QA. It requires an existing
Playwright installation, an installed Chrome, and a temporary output directory
specified using `GEORDI_PLAYWRIGHT_PATH`, `GEORDI_CHROME_PATH`, and
`GEORDI_REPORT_QA_DIR`. These are development tools, not application dependencies.
The check loads only synthetic report fixtures in an isolated headless browser,
blocks network requests, verifies pagination/readiness, and prints three sample
PDFs. It also reports whether the browser completed its CSV download; a canceled
download is reported as a limitation rather than a successful file save.
