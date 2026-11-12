# Sampling modes

Every connection starts in **Dashboard default**, using the original five fast
PIDs followed by one rotating slow PID. No focused retry policy applies there.

Once the dashboard is live, select **Focused diagnostics** before starting a
recording. Stop a recording before changing modes. Mode changes keep the same
connection, Elm command queue, and polling loop. A command already in flight is
allowed to finish; the new schedule applies before the next PID request.

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
