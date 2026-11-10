/**
 * Optional live example. Run: node examples/parabank-denied-loan.ts
 * Add --headed to watch it. Uses the public demo account john/demo.
 */
import { createEvidencePlaywright, evidenceFor, expect } from "../dist/index.js";

const {chromium} = createEvidencePlaywright({
    sut: "parabank", testObjective: "Request a loan that is denied",
});
const browser = await chromium.launch({headless: !process.argv.includes("--headed")});
try {
    const page = await browser.newPage();
    await page.goto("https://para.testar.org/parabank/index.htm");
    await page.locator('input[name="username"]').fill("john");
    await page.locator('input[name="password"]').fill("demo");
    await page.getByRole("button", {name: "Log In"}).click();
    await expect(page.getByText("Account Services", {exact: true})).toBeVisible();

    await page.getByRole("link", {name: "Request Loan", exact: true}).click();
    await expect(page.getByRole("heading", {name: "Apply for a Loan"})).toBeVisible();
    await page.locator("#amount").fill("999999");
    await page.locator("#downPayment").fill("1");
    await page.getByRole("button", {name: "Apply Now"}).click();
    await expect(page.locator("#loanStatus")).toHaveText("Denied");

    const recorder = await evidenceFor(page);
    await recorder.finish();
    console.log("Evidence directory:", recorder.directory);
} finally {
    await browser.close();
}
