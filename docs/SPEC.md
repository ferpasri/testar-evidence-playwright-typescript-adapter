# Playwright adapter specification

The adapter translates browser operations and caller-supplied information into the shared [evidence format](https://github.com/ferpasri/testar-evidence-specs/blob/main/docs/evidence-format.md). The evidence library validates records, references, lifecycle order, and artifact integrity.

Each page recorder owns one test run and one test sequence. Independent page traces use unique timestamped directories. Sequence completion precedes run completion. Optional origin and test objective descriptions remain unchanged in `evidence.origin` and `evidence.test_objective`; adapter identity is recorded separately.

## Automatic recording

The facade returns stable delegating proxies for browsers, contexts, pages, frames, locators, element handles, and input devices. Native methods receive their original arguments with wrapped Playwright objects restored to native objects. Page callbacks and returned popup pages use the same facade.

Supported navigation, content changes, element interactions, keyboard, mouse, and touch calls become recorded actions. Reads, waits, evaluation, and trial actions retain their native purpose.

Recording saves the source observation and action selection before invoking the operation. A normal return records `returned`; an exception records `error` and reaches the original caller. A later observation supplies a recorded transition for a returned execution. An error supplies no completed transition.

## Captures and available actions

| API | Meaning |
| --- | --- |
| `PlaywrightEvidence.start(directory, page, options)` | Create evidence at an exact directory. |
| `startTrace(page, options)` | Reserve a timestamped directory below the configured parent. |
| `capture()` | Capture a new buffered observation, committing any previous buffer. |
| `commitCapture()` | Save the buffer without another DOM capture or screenshot. |
| `observe()` | Capture and commit an observation. |
| `recordAvailableActions(actions, options)` | Record caller-reported actions and their scope. |
| `selectAction(action, options)` / `reportActionResult(outcome, error?)` | Record selection and an externally obtained execution outcome. |
| `selectRecordedAction(action, observation, parameters)` | Select a reported binding from the latest committed observation. |
| `executeSelected(operation)` | Invoke that selection and record its outcome, suppressing duplicate facade executions. |
| `perform(action, operation, options)` | Record one explicit action or compound action and capture its result. |
| `finish(reason)` | Commit buffered data and finish sequence and run. |

An `AvailableAction` contains `actionType`, `name`, optional `locator`, and optional planning `parameters`. Actual input belongs to execution parameters. Descriptions retain `playwright.description`, `playwright.locator`, and `playwright.available_parameters`. Abstraction rules belong to consumers.

Available-action scope is generated, eligible, or unknown. Automatic recording reports its selected operation with unknown scope. Caller-reported alternatives remain available even when unexecuted.

An explicit observation ID must identify the current buffer. Recording actions against that ID reuses the capture. Optional target paths identify widgets in that capture; otherwise simple CSS targets are resolved together in bounded browser calls and other locators use native individual resolution. Selection from a committed observation rejects stale observations, newer buffered captures, and ambiguous or unreported bindings.

Only one recording operation runs at a time per page. Independent pages have independent recorders. The recorded history exposes committed immutable facts; buffered observations become available after commit.

## Compound actions

`perform(..., {recordOperations: true})` records one parent execution while retaining supported native child operations in order. Its resulting observation references an `application/json` artifact with format `compound-action-operations`, version 1, the parent execution ID, and `operations`.

Child operation records require calls through the facade on that same page. Each child contains its index, method, action type, locator description, parameters, outcome, and error. Native child operations are delegated once. The parent execution parameters include `playwright.compound_action: true`. Intermediate captures are omitted inside this boundary; password arguments and related errors are redacted.

## Test oracles

The exported `expect` delegates retries and timeouts to Playwright and records one final result for GUI assertions. Negation is retained in oracle parameters. Supported readings identify state properties, widgets, or widget properties; collection assertions target the observation. Unresolved widget bindings retain an observation-level target and an explanation.

`checks.evaluate(report)` runs a custom oracle once and records its outcome. `checks.recordResult(report)` records a result already obtained by a tool. Reports can include expected and observed values, oracle details, severity, and an explicit buffered observation ID.

Assertion evaluation normally captures after the assertion. Supplying an observation ID requests reuse of that buffer. Reading and capture remain separate operations and can observe application changes. Original oracle failures reach the caller; `checks.recordingError` retains an additional recording failure.

Generic value assertions retain native behavior. Ordinary JavaScript assertions, soft assertions, polling, and externally implemented oracles use explicit reporting for GUI evidence. Native soft assertions do not automatically establish a passed oracle result.

## Captured properties

Capture includes the top document, DOM elements, and open shadow roots, including hidden elements within configured limits. Frame documents and closed shadow roots have explicit capture limitations.

| Data | Recorded properties |
| --- | --- |
| Document address/title | `playwright.document.url/title`, aliased to `ui.url/title`. |
| Attributes | `playwright.attribute.*`. |
| Live DOM values | `playwright.dom.*`, with aliases for selected concrete values. |
| Bounds and selected computed styles | `playwright.dom.bounds`, `ui.bounds`, and `playwright.style.*`. |
| Selection and omissions | `evidence.capture`, `evidence.omitted_properties`, and `evidence.property_aliases`. |

Widget title attributes remain attributes. Accessible names and widget titles are not inferred. CSS display/visibility values retain their separate meanings. A visibility oracle's Playwright reading is recorded separately as `playwright.dom.visible`.

DOM data is transferred as JSON text; screenshots are separate viewport PNGs. Defaults limit capture to 2,000 widgets, 8,192 characters per string, 4,194,304 selected property characters, and 256 attributes per widget. Maximums are 5,000, 65,536, 8,388,608, and 1,024 respectively. Callers can select computed styles, exclude attributes, and disable screenshots. Capture descriptions record truncation and known exclusions.

Password DOM values and supported secret input arguments are redacted. Automatic password-value assertions withhold expected/observed values and saved error details. Custom report authors control the data they supply.
