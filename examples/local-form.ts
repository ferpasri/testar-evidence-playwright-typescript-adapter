/**
 * Run: node examples/local-form.ts
 * Add --headed to watch the browser. The example uses an in-memory page.
 */
import { createEvidencePlaywright, evidenceFor, expect } from "../dist/index.js";

// All options are optional. evidencePath selects the parent folder; each page
// receives its own timestamped trace directory. Metadata describes this test run.
const {chromium} = createEvidencePlaywright({
    evidencePath: "target/traces", sut: "local-form",
    testObjective: "Enter a customer name and submit the form",
});
const browser = await chromium.launch({headless: !process.argv.includes("--headed")});
try {
    const page = await browser.newPage();
    await page.setContent(`<title>Application form</title>
        <label>Name<input id="name"></label>
        <button onclick="document.querySelector('#status').textContent='Submitted'">Apply</button>
        <p id="status">Ready</p>`);

    // These remain native Playwright calls; the facade records them automatically.
    await page.locator("#name").fill("John");
    await page.getByRole("button", {name: "Apply"}).click();
    await expect(page.locator("#status")).toHaveText("Submitted");

    const recorder = await evidenceFor(page);
    await recorder.finish();
    console.log("Evidence directory:", recorder.directory);
} finally {
    await browser.close();
}
