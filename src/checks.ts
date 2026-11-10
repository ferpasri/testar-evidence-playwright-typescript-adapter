import type { Locator } from "playwright";
import {
    evidenceEvent, validateEvent, type OracleResult, type ObservedValue, type Properties,
} from "testar-evidence";
import type { PlaywrightEvidence } from "./evidence.js";
import type { OracleReport, OracleEvaluation } from "./types.js";
import { native } from "./registry.js";
import { recordingScope } from "./scope.js";
import { errorText, requireAdapter } from "./util.js";

/** Preserve the native oracle's retries and outcome; recording never reruns its assertion. */
export class Checks {
    recordingError: unknown = null;
    constructor(private recorder: PlaywrightEvidence) {}

    private validate(report: OracleReport): void {
        const result: OracleResult = {
            test_run: this.recorder.runId, test_sequence: this.recorder.sequenceId,
            name: report.name, oracle: report.oracle, oracle_status: report.oracleStatus,
            oracle_target: {target_type: "test_run"}, oracle_details: report.oracleDetails ?? {},
        };
        if (report.expectedValue !== undefined) {
            result.expected_value = report.expectedValue;
        }
        if (report.observedValue !== undefined) {
            result.observed_value = report.observedValue;
        }
        if (report.oracleSeverity !== undefined) {
            result.oracle_severity = report.oracleSeverity;
        }
        validateEvent(evidenceEvent("validate-oracle", "oracle_result_recorded", result));
    }

    private async save(report: OracleReport, refresh: boolean): Promise<void> {
        this.validate(report);
        const observation = await this.recorder.oracleObservation(report.observation, refresh);
        const resolved = await this.recorder.oracleTarget(report.locator, report.property, observation);
        const result: OracleResult = {
            test_run: this.recorder.runId, test_sequence: this.recorder.sequenceId,
            name: report.name, oracle: report.oracle, oracle_status: report.oracleStatus,
            oracle_target: resolved.target,
            oracle_details: {...resolved.details, ...report.oracleDetails},
            observed_value: report.observedValue ?? {value_status: "unknown"},
        };
        if (report.expectedValue !== undefined) {
            result.expected_value = report.expectedValue;
        }
        if (report.oracleSeverity !== undefined) {
            result.oracle_severity = report.oracleSeverity;
        }
        await this.recorder.recordOracle(result);
    }

    /** Report an existing result, reusing its buffered observation when supplied. */
    async recordResult(report: OracleReport): Promise<void> {
        this.validate(report);
        return this.recorder.exclusive(async () => {
            this.recordingError = null;
            try {
                await this.save(report, false);
            } catch (error) {
                this.recordingError = error;
                throw error;
            }
        });
    }

    /** Execute a custom/native assertion and record one final evaluation. Original errors reach the caller. */
    async evaluate(report: OracleEvaluation): Promise<void> {
        requireAdapter(typeof report.assertion === "function" && (report.observedValue === undefined || typeof report.observedValue === "function"), "Supply assertion and observed-value callbacks.");
        this.validate({...report, oracleStatus: "passed", observedValue: undefined});
        return this.recorder.exclusive(async () => {
            this.recordingError = null;
            let failed = false;
            let failure: unknown;
            let status: OracleResult["oracle_status"] = "passed";
            let observed: ObservedValue = {value_status: "unknown"};
            const details: Properties = {...report.oracleDetails};
            await recordingScope.run({recorder: this.recorder}, async () => {
                try {
                    await report.assertion();
                } catch (error) {
                    failed = true;
                    failure = error;
                    status = error instanceof Error && (error.name === "AssertionError" || "matcherResult" in error) ? "failed" : "error";
                    details["playwright.assertion_error"] = report.redact ? "Sensitive value assertion failed; details redacted." : errorText(error);
                }
                if (!report.redact && report.observedValue) {
                    try {
                        observed = await report.observedValue();
                    } catch {
                        details["playwright.reading_error"] = "Observed value unavailable after assertion.";
                    }
                }
                try {
                    await this.save({...report, expectedValue: report.redact ? undefined : report.expectedValue,
                        observedValue: observed, oracleStatus: status, oracleDetails: details}, report.observation === undefined);
                } catch (error) {
                    this.recordingError = error;
                    if (!failed) {
                        throw error;
                    }
                }
            });
            if (failed) {
                throw failure;
            }
        });
    }

    hasText(locator: Locator, expected: string, name = "Text matches"): Promise<void> {
        return this.evaluate({name, oracle: {id: "playwright:toHaveText", version: "1"}, locator,
            property: "playwright.dom.textContent", expectedValue: expected,
            assertion: async () => {
                const {expect} = await import("playwright/test");
                await expect(native(locator)).toHaveText(expected);
            },
            observedValue: async () => ({value_status: "value", value: await native(locator).textContent({timeout: 100})}),
        });
    }
}
