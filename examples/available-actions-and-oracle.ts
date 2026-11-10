/**
 * An explicit observation cycle for tools that derive their own available actions.
 * Run: node examples/available-actions-and-oracle.ts
 */
import { chromium as nativeChromium } from "playwright";
import { recordPage, evidenceFor } from "../dist/index.js";

const browser = await nativeChromium.launch({headless: true});
try {
    const nativePage = await browser.newPage();
    await nativePage.setContent('<title>Customer form</title><input id="name"><button id="apply">Apply</button>');
    // Attach recording to an existing page. Subsequent supported operations use the facade.
    const page = await recordPage(nativePage, {
        sut: "customer-form", testObjective: "Record available actions and a custom oracle",
    });
    const recorder = await evidenceFor(page);

    const source = await recorder.capture();
    const enterName = {actionType: "fill", name: "Enter customer name", locator: page.locator("#name")};
    const apply = {actionType: "click", name: "Apply", locator: page.locator("#apply")};
    await recorder.recordAvailableActions([enterName, apply], {scope: "eligible", observation: source});
    await recorder.commitCapture();

    // The calling tool chooses the action here. The evidence adapter records that
    // choice; ASM-based selection belongs to the separate ASM integration.
    await recorder.selectRecordedAction(enterName, source, {value: "John"});
    await recorder.executeSelected(() => enterName.locator.fill("John"));

    const result = await recorder.capture();
    const observed = await page.locator("#name").inputValue();
    // This result comes from the tool's own oracle, not a Playwright assertion.
    await recorder.checks.recordResult({
        oracle: {id: "example:customer-name", version: "1"},
        name: "Customer name is John", oracleStatus: observed === "John" ? "passed" : "failed",
        locator: page.locator("#name"), property: "playwright.dom.value",
        expectedValue: "John", observedValue: {value_status: "value", value: observed},
        observation: result,
    });
    await recorder.commitCapture();
    await recorder.finish();
    console.log("Evidence directory:", recorder.directory);
} finally {
    await browser.close();
}
