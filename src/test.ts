import { test as playwrightTest } from "playwright/test";
import { EvidenceRuntime } from "./facade.js";
import type { EvidenceOptions } from "./types.js";

export { expect } from "./assertions.js";
export { defineConfig, devices } from "playwright/test";
export type EvidenceTestOptions = {evidenceOptions: EvidenceOptions};

/** Wrap the native context so the page fixture, new pages, and popup pages share recording options. */
export const test = playwrightTest.extend<EvidenceTestOptions>({
    evidenceOptions: [{}, {option: true}],
    context: async ({context, evidenceOptions}, use, testInfo) => {
        const runtime = new EvidenceRuntime({
            ...evidenceOptions,
            evidencePath: evidenceOptions.evidencePath ?? testInfo.outputPath("evidence"),
            testObjective: evidenceOptions.testObjective ?? testInfo.title,
        });
        try {
            await use(runtime.wrap(context, "Context"));
        } finally {
            await runtime.finish();
        }
    },
});
