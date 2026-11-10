import { describe, test, expect } from "vitest";
import { expect as evidenceExpect, evidenceFor } from "../src/index.js";
import { html, fixture } from "./support.js";

describe("Automatic recording", () => {
    test("record navigation, input, click, and their resulting states", async () => {
        const example = await fixture();
        try {
            await example.page.goto(example.url);
            await example.page.locator("#name").fill("John");
            await example.page.locator("#apply").click();
            await evidenceExpect(example.page.locator("#status")).toHaveText("Submitted");
            const history = await example.read();
            expect(history.actionExecutions).toHaveLength(3);
            expect(history.recordedTransitions).toHaveLength(3);
            expect(history.oracleResults).toHaveLength(1);
            expect(history.oracleResults[0]).toMatchObject({
                oracle_status: "passed",
                oracle_target: {target_type: "widget_property", property: "playwright.dom.textContent"},
                observed_value: {value_status: "value", value: "Submitted"},
            });
            expect(history.testRuns[0].status).toBe("finished");
            expect(history.testRuns[0].test_run.properties).not.toHaveProperty("evidence.origin");
            expect(history.testSequences[0].status).toBe("finished");
        } finally {
            await example.close();
        }
    });

    test("readiness checks, reads, and evaluate keep their native purpose", async () => {
        const example = await fixture();
        try {
            await example.page.setContent(html);
            const count = example.recorder.recordedEvidence.actionExecutions.length;
            await example.page.locator("#apply").click({trial: true});
            await example.page.locator("#name").count();
            await example.page.title();
            await example.page.evaluate(() => document.title);
            const argument: {self?: unknown} = {};
            argument.self = argument;
            expect(await example.page.evaluate(value => value.self === value, argument)).toBe(true);
            expect(example.recorder.recordedEvidence.actionExecutions).toHaveLength(count);
        } finally {
            await example.close();
        }
    });

    test("retain an error result and rethrow the native Playwright error", async () => {
        const example = await fixture();
        try {
            await example.page.goto(example.url);
            let failure: unknown;
            try {
                await example.page.locator("#missing").click({timeout: 50});
            } catch (error) {
                failure = error;
            }
            expect(failure).toBeInstanceOf(Error);
            const history = await example.read();
            expect(history.actionExecutions.at(-1)?.status).toBe("failed");
            expect(history.actionExecutions.at(-1)?.execution_result?.error).toContain("Timeout");
            expect(history.recordedTransitions).toHaveLength(1);
        } finally {
            await example.close();
        }
    });

    test("password input and value assertion details are redacted", async () => {
        const example = await fixture();
        try {
            await example.page.goto(example.url);
            await example.page.locator("#password").fill("private-input-value");
            await evidenceExpect(example.page.locator("#password")).toHaveValue("private-input-value");
            const history = await example.read();
            const text = JSON.stringify(history.events, (_name, value) => typeof value === "bigint" ? value.toString() : value);
            expect(text).not.toContain("private-input-value");
            expect(history.actionExecutions.at(-1)?.action_execution.parameters["playwright.redacted_parameters"]).toContain("value");
            expect(history.oracleResults.at(-1)?.observed_value).toEqual({value_status: "unknown"});
        } finally {
            await example.close();
        }
    });

    test("popup callbacks and waitForEvent return recorded pages with stable identity", async () => {
        const example = await fixture();
        try {
            await example.page.goto(example.url);
            let callbackPage: unknown;
            const callback = (page: unknown) => { callbackPage = page; };
            example.page.on("popup", callback);
            const waiting = example.page.waitForEvent("popup");
            await example.page.locator("#popup").click();
            const popup = await waiting;
            await popup.waitForLoadState();
            expect(callbackPage).toBe(popup);
            example.page.off("popup", callback);
            await popup.locator("#name").fill("Popup customer");
            const popupEvidence = await evidenceFor(popup);
            await popup.close();
            expect(await evidenceFor(popup)).toBe(popupEvidence);
            expect(popupEvidence.recordedEvidence.actionExecutions).toHaveLength(1);
            expect(popupEvidence.recordedEvidence.testRuns[0].status).toBe("finished");
        } finally {
            await example.close();
        }
    });
});

describe("Available actions and compound actions", () => {
    test("reuse one captured state for choices, execution selection, and an oracle result", async () => {
        const example = await fixture();
        try {
            await example.page.goto(example.url);
            const source = await example.recorder.capture();
            const apply = {actionType: "click", name: "Apply", locator: example.page.locator("#apply")};
            const unused = {actionType: "click", name: "Another action", locator: example.page.locator("#unused")};
            await example.recorder.recordAvailableActions([apply, unused], {scope: "eligible", observation: source});
            await example.recorder.commitCapture();
            const before = example.recorder.recordedEvidence.observations.length;
            await example.recorder.selectRecordedAction(apply, source);
            await example.recorder.executeSelected(() => apply.locator.click());
            const result = await example.recorder.capture();
            await example.recorder.checks.recordResult({
                oracle: {id: "application:submitted", version: "1"}, name: "Submission accepted",
                oracleStatus: "passed", locator: example.page.locator("#status"),
                property: "playwright.dom.textContent", observation: result,
                observedValue: {value_status: "value", value: "Submitted"},
                oracleSeverity: {label: "critical", value: 1},
            });
            await example.recorder.commitCapture();
            expect(example.recorder.recordedEvidence.observations).toHaveLength(before + 1);
            expect(example.recorder.recordedEvidence.availableActions(source)).toHaveLength(2);
            const history = await example.read();
            expect(history.oracleResults.at(-1)?.oracle_severity?.label).toBe("critical");
            expect(history.actionExecutions.at(-1)?.status).toBe("completed");
        } finally {
            await example.close();
        }
    });

    test("keep text entry as one transition and retain its ordered native operations", async () => {
        const example = await fixture();
        try {
            await example.page.goto(example.url);
            const name = example.page.locator("#name");
            await example.recorder.perform({actionType: "type", name: "Enter customer name", locator: name}, async () => {
                await name.fill("");
                await name.pressSequentially("John");
                await name.press("Enter");
            }, {recordOperations: true});
            const history = await example.read();
            // Navigation plus one compound execution; the three child operations are evidence artifacts.
            expect(history.actionExecutions).toHaveLength(2);
            expect(history.recordedTransitions).toHaveLength(2);
            const artifact = history.observations.flatMap(item => item.artifacts).find(item => item.media_type === "application/json")!;
            const {readFile} = await import("node:fs/promises");
            const operations = JSON.parse(await readFile(example.recorder.directory + "/" + artifact.path, "utf8"));
            expect(operations.format).toBe("compound-action-operations");
            expect(operations.operations.map((item: any) => item.method)).toEqual(["Locator.fill", "Locator.pressSequentially", "Locator.press"]);
        } finally {
            await example.close();
        }
    });

    test("a stale coordinated observation is rejected before invoking the operation", async () => {
        const example = await fixture();
        try {
            await example.page.goto(example.url);
            const older = await example.recorder.capture();
            await example.recorder.capture();
            let invoked = false;
            await expect(example.recorder.perform({actionType: "click", name: "Apply", locator: example.page.locator("#apply")},
                async () => { invoked = true; }, {sourceObservation: older})).rejects.toThrow("current buffered");
            expect(invoked).toBe(false);
        } finally {
            await example.close();
        }
    });
});

test("a custom oracle preserves its supplied result and invalid reports never invoke callbacks", async () => {
    const example = await fixture();
    try {
        await example.page.goto(example.url);
        let evaluated = 0;
        await example.recorder.checks.evaluate({
            oracle: {id: "application:status"}, name: "Status is ready",
            locator: example.page.locator("#status"), property: "playwright.dom.textContent",
            assertion: async () => {
                evaluated++;
                if (await example.page.locator("#status").textContent() !== "Ready") {
                    throw new Error("Unexpected application status");
                }
            },
            observedValue: async () => ({value_status: "value", value: "Ready"}),
        });
        await expect(example.recorder.checks.evaluate({
            oracle: {id: ""}, name: "Invalid oracle", assertion: async () => { evaluated++; },
        })).rejects.toThrow();
        expect(evaluated).toBe(1);
        const history = await example.read();
        expect(history.oracleResults).toHaveLength(1);
        expect(history.oracleResults[0].oracle.id).toBe("application:status");
    } finally {
        await example.close();
    }
});
