# TESTAR Evidence Playwright Adapter for TypeScript and JavaScript

Record concrete GUI test evidence while delegating browser operations to the official Playwright library. The adapter supports automatic recording and explicit reporting for tools with their own available actions and test oracles.

## Install

~~~shell
npm install playwright github:ferpasri/testar-evidence-playwright-typescript-adapter#v0.3.0
npx playwright install chromium
~~~

The package imports as `testar-evidence-playwright`. It uses the published TypeScript evidence library to validate and write traces.

## Minimal integration

For a standalone script, replace the Playwright browser import and import the adapter's `expect` for automatic GUI assertion results:

~~~typescript
import { chromium, expect } from "testar-evidence-playwright";

const browser = await chromium.launch();
try {
    const page = await browser.newPage();
    await page.goto("https://example.org");
    await expect(page).toHaveTitle(/Example/);
} finally {
    await browser.close();
}
~~~

Supported operations are delegated through a facade. Each recorded page creates a timestamped trace under `target/traces`. Traces contain a manifest, JSONL events, and referenced artifacts. Closing through the facade finishes the corresponding traces.

Use `createEvidencePlaywright(options)` to configure the output parent directory, optional SUT label, origin, test objective, and capture settings. The [local form example](examples/local-form.ts) explains these options.

## Playwright Test

Import `test` and `expect` from the test entry point. Its context fixture also records additional pages and popups.

~~~typescript
import { test, expect } from "testar-evidence-playwright/test";

test("application title", async ({ page }) => {
    await page.goto("https://example.org");
    await expect(page).toHaveTitle(/Example/);
});
~~~

Optional settings use `test.use({ evidenceOptions: { ... } })`. By default, traces go under the test's Playwright output directory and its title becomes the test objective label.

## Deeper integration

`recordPage(page, options)` wraps an existing native page. `await evidenceFor(page)` returns its recorder. Tools can report available actions, coordinate captures, group compound actions, and record custom oracle results. The [explicit integration example](examples/available-actions-and-oracle.ts) shows the observation-action-observation cycle.

The [specification](docs/SPEC.md) describes recorded data and APIs. [How it works](docs/how-it-works.md) explains the implementation components.

## Development

Requires Node.js 24 or later.

~~~shell
npm ci
npx playwright install chromium
npm run check
npm run test:runner
npm run example
~~~

Tests use controlled local pages. The optional [ParaBank example](examples/parabank-denied-loan.ts) demonstrates a login and denied-loan request against a live demo application.

Package versions and dependencies are declared in `package.json`. Remaining work is tracked in [TODO](TODO.md).
