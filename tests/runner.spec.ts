import { test, expect } from "../src/test.js";
import { evidenceFor } from "../src/index.js";

test("the page fixture records actions and supported assertions", async ({page}) => {
    await page.setContent('<title>Fixture form</title><input id="name"><p id="result">Ready</p>');
    await page.locator("#name").fill("John");
    await expect(page.locator("#name")).toHaveValue("John");
    const recorder = await evidenceFor(page);
    await recorder.commitCapture();
    expect(recorder.recordedEvidence.actionExecutions.length).toBe(2);
    expect(recorder.recordedEvidence.oracleResults[0].oracle_status).toBe("passed");
});

test("additional context pages use the same recording integration", async ({context}) => {
    const page = await context.newPage();
    await page.setContent('<title>Second page</title><button id="apply">Apply</button>');
    await page.locator("#apply").click();
    const recorder = await evidenceFor(page);
    await recorder.commitCapture();
    expect(recorder.recordedEvidence.actionExecutions.length).toBe(2);
});
