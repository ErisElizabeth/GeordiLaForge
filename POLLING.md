# Sampling modes

Every connection starts in **Dashboard default**, using the original five fast
PIDs followed by one rotating slow PID. No focused retry policy applies there.

Once the dashboard is live, select **Focused diagnostics** before starting a
recording. Stop a recording before changing modes. Mode changes keep the same
connection, Elm command queue, and polling loop. A command already in flight is
allowed to finish; the new schedule applies before the next PID request.

**Oxygen Sensor Comparison** and **Fuel Trim Comparison** are additional
Milestone 5 profiles. Dashboard default and the M4 Focused schedule below retain
their existing request order, pools and retry behavior.

## ECU capabilities

Open **ECU capabilities** to see advertised Mode 01 PIDs, decoder availability,
latest observed response quality/reason, and selected comparison-profile
suitability. The reference filter also shows known parameters not advertised by
this ECU. Opening or filtering the inventory sends no commands.

"Supported and decoded" means a decoder exists; the separate observation column
identifies whether a response has actually decoded successfully on this
connection. An intermittent missing/invalid response does not erase earlier
success. Retry status is shown separately. Unknown advertised PIDs remain
visible without being probed. The support bitmap walk continues beyond `60`
only when the preceding bitmap advertises the next range, and stops at `E0`.
Continuation bits are not reported as measurement channels.

Existing decoders already cover module voltage (`42`), fuel/rail pressure
(`0A`, `22`, `23`), manifold pressure (`0B`), MAF (`10`), engine run time (`1F`),
catalyst temperatures (`3C`–`3F`), commanded lambda (`44`), warm-ups (`30`) and
distance since clearing (`31`). No duplicate decoders or Mode 06 interpretation
were added. The new static decoder is the alternative O2 layout (`1D`).

## Bank-comparison profiles

Both profiles use the existing single loop and Elm queue. Only advertised,
decoder-known candidates with a successful decoded response enter the eligible
pool. At most one unvalidated candidate is checked per round through that same
loop, after eligible scheduled readings. Pending target validations precede
pending context validations. These are ordinary, timestamped results, including
missing/invalid responses; they are not invented values or unsupported probes.
If validation has already succeeded in Dashboard mode, it need not be repeated.

| Profile | Target order (starting target rotates each round) | RPM | Other conditions |
| --- | --- | --- | --- |
| Oxygen Sensor Comparison | B1S1, B2S1, B1S2, B2S2, where verified | Every second round | One rotating condition every fourth round |
| Fuel Trim Comparison | Short B1 (`06`), short B2 (`08`), long B1 (`07`), long B2 (`09`) | Every round | One rotating condition every fourth round |

The context rotation is coolant (`05`), load (`04`), throttle (`11`), and
fuel-system status (`03`). An eligible context can also run when the target/RPM
batch is empty. There is no optional general background pool in these two
profiles. Other dashboard channels can therefore become stale; switch back to
Dashboard default to refresh them. Neither new profile adds hot-path adapter
commands: periodic `ATRV` is suspended and its voltage chip is hidden until a
mode with voltage refresh is selected. M4 Focused retains its existing `ATRV`
behavior. Module-voltage PID `42` is not a comparison target.

Every available target gets one turn per round. A paused or unavailable bank
does not delay eligible targets in the other bank. The same M4 15/30/60-second
retry policy applies to eligible readings and pending validation. If no suitable
advertised target exists, the UI explicitly reports a Dashboard-schedule fallback.

For the standard `13` layout, verified B1/B2 upstream/downstream voltage PIDs
are `14`/`15` and `18`/`19`. With only the alternative `1D` layout, B2 uses
`16`/`17`; `18`/`19` belong to Bank 3 and cannot enter the B2 comparison.
Both the PID advertisement and its sensor-present bit are required. When neither
layout, both layouts, or no valid layout response is available, locations remain
unverified and are excluded from oxygen comparison. M4's original conservative
Bank 1 verification policy is unchanged.
The alternative mapping is documented in [Clutch Engineering's parameter reference](https://pelican.clutch.engineering/cars/saej1979/parameters)
(Mode 01 `16`/`17` descriptions distinguish layouts `13` and `1D`).

Comparison graphs pair the two banks' upstream voltages and downstream voltages,
or their short and long trims, plus the existing engine-condition plots. They
reuse the same Canvas renderer, actual timestamps, range selection, inspection,
missing/failed markers, and print layout. A bank without a verified channel is
explicitly unavailable. Wide-range voltage/current PIDs (`24`–`2B`, `34`–`3B`)
are not decoded or substituted into these voltage comparisons.

The selected/requested mode, policy, capability observations, and bank/sensor
mapping are snapshotted at recording start. Subsequent validation or profile
changes cannot rewrite that snapshot. Reports use the saved mapping, not the
current connection. CSV retains the existing 26-column schema, native values,
individual failures/reasons, and profile/policy fields. All recorded results
remain in CSV regardless of graph range. VIN omission and note opt-in defaults,
in-memory-only storage, 20,000-result/60-minute limits, and export-before-reload
requirements are unchanged.

## Expected tradeoffs

The vehicle's observed 3.25–3.34 PID results/s is evidence from that vehicle and
adapter, not a guarantee. Under a synthetic 120-second model at 303 ms/request,
with all targets validated, the test fixture produced:

| Profile | B1 upstream / downstream | B2 upstream / downstream | Each B1 trim | Each B2 trim |
| --- | --- | --- | --- | --- |
| M4 Focused baseline | 62 / 62 | 2 / 2 | 62 | 3 |
| Oxygen comparison | 83 / 83 | 83 / 83 | Not scheduled | Not scheduled |
| Trim comparison | Not scheduled | Not scheduled | 75 | 75 |

These are modeled counts, not measured vehicle rates. Discovery, cold validation,
timeouts, retries, manual reads and differing ECU latency affect actual results.
The nominal four-O2 comparison would still provide only about 0.7 Hz per sensor
at that simulated throughput. Sequential, sparse observations cannot establish
simultaneity, O2 switching speed, catalyst efficiency, or a definitive fault.
The live profile table shows achieved valid Hz, age, and mean/latest request
latency, including queue wait, since selecting the profile. Recording statistics
remain independent of subsequent live acquisition.

## Focused schedule

Each round requests every available priority PID once:

- `14` / `15`: Bank 1 O2 voltages, only when the recorded `13` sensor bitmap
  confirms their locations and the alternative `1D` layout is not advertised.
- `06` / `07`: Bank 1 short/long fuel trim, when advertised and decoded.
- `0C`: RPM, when advertised and decoded.

One essential condition rotates each round: load, throttle, coolant, fuel-system
status, and speed. One other supported, decoded, dynamic PID rotates every fourth
round, or sooner when all priority/context requests are waiting. These pools are
disjoint; no PID is requested twice in a round. Unverified O2 PIDs may still be
sampled in the general background pool with unverified labels.

When no verified Bank 1 O2 or supported Bank 1 trim target exists, the selector
reports that focused sampling is unavailable and uses the default schedule.

## Intermittently unavailable data

In focused mode, two consecutive missing or invalid results for a PID pause that
PID for 15 seconds. Subsequent failures increase that pause to 30 and then 60
seconds, capped there. A valid reply clears the failure streak. No PID is
permanently removed. Paused PIDs are retried by the same polling loop; waiting
does not create missing or zero-valued samples. When everything is waiting, the
loop waits without issuing adapter-voltage queries repeatedly.

Transport exceptions and the existing global ECU-failure stop behavior are
preserved. Request timeouts, Bluetooth transport, and the Elm queue are unchanged.

## Rates and evidence

The live focused statistics show actual valid-sample interval rates, age,
missing/failed counts, and retry status since selecting the mode. They keep
updating after a recording stops. Recording graphs/statistics describe only that
recording. Every new recording saves its sampling policy, includes a sampling
boundary event in the report, and exports `polling_mode` / `polling_policy` in CSV.
Older recordings without this metadata leave those CSV fields empty.

Other dashboard values refresh less often in focused mode. The total adapter
throughput is not an individual O2 sensor's rate. Even improved O2 sampling is
sequential and may remain too sparse to resolve switching speed or assess a
catalytic converter. Use achieved rates and individual timestamps.

## Verification

The dependency-free scheduler tests are in `tests/polling.test.js`; run them with
the recording, graph, and export suites listed in `EXPORTS.md`. They include a
fixed-latency scheduling comparison, which is a model and not vehicle evidence.

`tests/polling-browser-check.js` optionally checks the actual controls, responsive
layout, demo acquisition, and focused-recording report readiness in an isolated
browser. It uses the same existing Playwright/Chrome development configuration
as the report QA check, plus `GEORDI_POLLING_QA_DIR` for temporary screenshots.
Bluetooth is removed from that test context, and external requests are blocked.

Milestone 5 adds `tests/comparison.test.js` (inventory, layouts, validation,
fairness, retries, constrained throughput, recording snapshots, graphs, CSV and
dual-bank mocked Demo integration). Run all suites with:

```powershell
node --test tests/*.test.js
```

`tests/comparison-browser-check.js` optionally checks both new profiles in an
isolated Chrome/Playwright context, including intermittent/malformed mock sensor
responses, desktop/mobile graphs, range inspection, report-preview readiness and
Letter PDFs. Set `GEORDI_COMPARISON_QA_DIR` for temporary QA output, plus the
existing Playwright/Chrome environment variables. It uses no actual adapter.

## User vehicle acceptance procedure

1. Connect normally and confirm Dashboard default works. Review the advertised
   inventory and layout/Bank 2 availability. Do not assume a second bank exists.
2. Choose Oxygen Sensor Comparison before recording. Allow advertised candidates
   to validate. At stable warm idle, record roughly two minutes; note actual
   per-PID Hz, age, latency and any retry status. Do not infer a waveform from
   sparse markers. For comparable sessions, use the same observed conditions.
3. Stop and inspect both comparison plots and individual timestamps. Unsupported
   or unverified banks should remain unavailable. Export report and CSV before
   starting the next recording or reloading. Check the saved profile, native
   units, privacy options and all missing/failed rows.
4. Repeat with Fuel Trim Comparison, checking both short and long trims and RPM.
   Confirm occasional coolant/load/throttle/fuel-status results in sampling
   statistics/CSV; not every recorded channel is a numeric graph.
5. After stopping, change to M4 Focused, then Dashboard default. Confirm the
   connection stays open, broader dashboard readings resume, and the completed
   recording and its exported graph/profile remain unchanged. Compare actual
   rates with an M4 session under the same operating conditions.

No vehicle was contacted during development. Real KWP FAST/BLE stability and
achieved rates require this separate user acceptance test. No initialization,
transport, command serialization, adapter timeouts or protocol timing was changed.

## Milestone 5 change and verification record

Added files:

- `capabilities.js`: passive inventory and verified O2 location mapping.
- `tests/comparison.test.js`: 17 additional automated tests.
- `tests/comparison-browser-check.js`: isolated browser and native-PDF QA.

Modified files:

- `pids.js`: alternative `1D` static layout decoder.
- `obd.js`: continuation-gated support bitmap extension only.
- `polling.js`: comparison planner reuses the unchanged M4 planner's retry state.
- `app.js`: profile selection, passive observations, latency, saved mapping,
  capability display, and verified dashboard O2 labels.
- `index.html`: profile choices, inventory, latency columns and comparison panels.
- `graphs.js`, `graph-ui.js`: saved-profile graph selection using the shared renderer.
- `exports.js`, `report.js`: saved profile/mapping handling and comparison reports.
- `tests/helpers.js`: load the new inventory module in the existing test harness.
- `POLLING.md`, `EXPORTS.md`: schedules, limitations and verification instructions.

Verification on 2026-11-12: all 95 automated tests passed, retaining the original
78. Isolated native Chrome checks passed for M4 and both comparison profiles on
desktop/mobile, with one request in flight, the original connection/loop,
zero JavaScript errors, and zero external network requests. Both comparison
reports rendered before print and produced seven-page Letter PDFs. Page bodies
had no detected overflow; rendered pages were visually reviewed. Extracted PDF
text confirmed the simulated-data warning on every page and VIN omission.
CSV generation preserved the existing schema and all observations. The browser
check writes generated CSV bytes directly for inspection; it does not establish
that Chrome's native download completed (the pre-existing isolated-download
limitation described in `EXPORTS.md` remains).

No new application dependencies or persistent storage were introduced. No
actual vehicle commands, Git commits or pushes were performed. Actual vehicle
stability, rate tradeoffs and unsupported Bank 2 coverage remain for user testing.
