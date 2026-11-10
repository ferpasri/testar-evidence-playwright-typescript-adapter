import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { expect as evidenceExpect } from "../src/index.js";
import { fixture } from "./support.js";

test("capture concrete DOM properties, hidden elements, shadow widgets, and screenshots", async () => {
    const example = await fixture({capture: {screenshots: true}});
    try {
        await example.page.goto(example.url);
        const history = await example.read();
        const observation = history.observations.at(-1)!;
        expect(observation.recorded_state.properties["ui.title"]).toBe("Application form");
        expect(observation.recorded_state.properties["ui.url"]).toBe(example.url + "/");
        const name = observation.recorded_state.widgets.find(widget => widget.properties["playwright.attribute.id"] === "name")!;
        expect(name.properties["playwright.attribute.title"]).toBe("Customer name");
        expect(name.properties).not.toHaveProperty("ui.title");
        const hidden = observation.recorded_state.widgets.find(widget => widget.properties["playwright.attribute.id"] === "hidden")!;
        expect(hidden.properties["playwright.style.display"]).toBe("none");
        expect(observation.recorded_state.widgets.some(widget => widget.properties["playwright.attribute.id"] === "shadow-button")).toBe(true);
        expect(observation.recorded_state.properties["playwright.capture.omitted_frame_documents"]).toBe(1);
        const screenshot = observation.artifacts.find(item => item.media_type === "image/png")!;
        expect((await readFile(example.recorder.directory + "/" + screenshot.path)).subarray(1, 4).toString()).toBe("PNG");
    } finally {
        await example.close();
    }
});

test("capture limits and excluded attributes retain an explanation", async () => {
    const example = await fixture({capture: {screenshots: false, maxWidgets: 8, excludedAttributes: ["title"]}});
    try {
        await example.page.goto(example.url);
        const history = await example.read();
        const state = history.observations.at(-1)!.recorded_state;
        expect(state.widgets.length).toBeLessThanOrEqual(8);
        expect(state.properties["evidence.capture"]).toMatchObject({truncated: true});
        expect(state.widgets.every(widget => !Object.hasOwn(widget.properties, "playwright.attribute.title"))).toBe(true);
    } finally {
        await example.close();
    }
});

test("record a failed final assertion and its observed value while preserving the original error", async () => {
    const example = await fixture();
    try {
        await example.page.goto(example.url);
        await expect(evidenceExpect(example.page.locator("#status")).toHaveText("Submitted", {timeout: 50})).rejects.toThrow();
        const history = await example.read();
        expect(history.oracleResults.at(-1)).toMatchObject({
            oracle_status: "failed", expected_value: "Submitted",
            observed_value: {value_status: "value", value: "Ready"},
        });
    } finally {
        await example.close();
    }
});

test("negated and page-property assertions keep their distinct oracle targets", async () => {
    const example = await fixture();
    try {
        await example.page.goto(example.url);
        await evidenceExpect(example.page).toHaveTitle("Application form");
        await evidenceExpect(example.page.locator("#status")).not.toHaveText("Submitted");
        await evidenceExpect(example.page.locator("#help")).toHaveAttribute("alt", "Help image");
        const history = await example.read();
        expect(history.oracleResults[0].oracle_target).toMatchObject({target_type: "state_property", property: "playwright.document.title"});
        expect(history.oracleResults[1].oracle.parameters?.negated).toBe(true);
        expect(history.oracleResults[2].oracle_target).toMatchObject({target_type: "widget_property", property: "playwright.attribute.alt"});
    } finally {
        await example.close();
    }
});

test("optional origin and test objective preserve Unicode and spacing", async () => {
    const example = await fixture({origin: "  QA équipe / CI  ", testObjective: "  Request loan — prêt  "});
    try {
        const history = await example.read();
        expect(history.testRuns[0].test_run.properties["evidence.origin"]).toBe("  QA équipe / CI  ");
        expect(history.testRuns[0].test_run.properties["evidence.test_objective"]).toBe("  Request loan — prêt  ");
    } finally {
        await example.close();
    }
});

test("a locator outside the captured document retains an observation-level oracle target", async () => {
    const example = await fixture();
    try {
        await example.page.goto(example.url);
        await evidenceExpect(example.page.frameLocator("iframe").getByText("Frame button")).toHaveText("Frame button");
        const history = await example.read();
        expect(history.oracleResults.at(-1)?.oracle_target.target_type).toBe("observation");
        expect(history.oracleResults.at(-1)?.oracle_details["playwright.target_resolution"]).toBe("not_captured");
    } finally {
        await example.close();
    }
});
