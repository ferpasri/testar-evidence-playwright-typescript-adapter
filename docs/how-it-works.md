# How recording connects to Playwright

The adapter sits between the caller and the native Playwright objects:

~~~text
Script or testing tool
    -> Playwright facade
        -> evidence recorder
        -> original Playwright operation
            -> browser
~~~

| File | What it does |
| --- | --- |
| `facade.ts` | Wraps returned objects, delegates native methods and callbacks, and identifies their page recorder. |
| `actions.ts` | Recognizes supported interactions and describes their supplied arguments. |
| `capture.ts` and `resources/` | Extract DOM facts, capture screenshots, and resolve locators to captured widgets. |
| `evidence.ts` | Coordinates observations, action descriptions, selections, outcomes, transitions, and artifacts. |
| `assertions.ts` / `checks.ts` | Delegate supported assertions or accept custom oracle results. |
| `scope.ts` | Prevents duplicate records inside explicit operations and retains compound-operation details when requested. |
| `test.ts` | Integrates recording into Playwright Test's context fixture. |

For `await page.locator("#name").fill("John")`, the facade identifies a fill operation. The recorder captures or reuses its source state, binds the locator when possible, writes selection, and delegates the original fill. It records the outcome and buffers the resulting state. The next action or finalization commits that observation and its transition.

A testing tool may also derive alternative actions or evaluate its own oracles. Those facts stay inside that tool unless it explicitly reports them through `recordAvailableActions` and `checks.recordResult`. The adapter preserves the tool's supplied facts; it does not derive an exploration policy.

For coordinated exploration, capture once, report available actions against that buffered observation, and commit it. Select a reported binding with `selectRecordedAction`, invoke it through `executeSelected`, then capture the result. This makes the two state captures and the execution boundary visible to the integration author.
