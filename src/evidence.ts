import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import {
    evidenceEvent, type EventType, type EventData, type Observation,
    type ActionDescription, type Properties, type OracleResult, type OracleTarget,
} from "testar-evidence";
import { JsonlStore } from "testar-evidence/node";
import { captureOptions, capturePage, targetPath, targetPaths, widgetId, type BrowserSnapshot, type ResolvedCaptureOptions } from "./capture.js";
import { native, pageRecorders } from "./registry.js";
import { recordingScope } from "./scope.js";
import { Checks } from "./checks.js";
import { identity, owned, requireAdapter, VERSION, errorText } from "./util.js";
import type { AvailableAction, EvidenceOptions, PerformOptions, NativeOperation } from "./types.js";

interface BufferedObservation {
    id: string;
    index: number;
    snapshot: BrowserSnapshot;
    bindings: Observation["available_actions"];
    scope: Observation["available_action_scope"];
    reported: boolean;
    oracles: OracleResult[];
    artifacts: Observation["artifacts"];
}

/** Translate one page's observations, operations, and test-oracle results into a concrete trace. */
export class PlaywrightEvidence {
    readonly page: Page;
    readonly runId: string;
    readonly sequenceId: string;
    readonly checks: Checks;
    readonly directory: string;
    readonly #store: JsonlStore;
    readonly #options: ResolvedCaptureOptions;
    #pending: BufferedObservation | null = null;
    #awaitingResult: string | null = null;
    #selected: {id: string; parameters: Properties; secret: boolean} | null = null;
    #lastObservation: string | null = null;
    #descriptions = new Map<string, ActionDescription>();
    #observations = 0;
    #executions = 0;
    #events = 0;
    #busy = false;
    #finished = false;
    recordingError: unknown = null;

    private constructor(page: Page, store: JsonlStore, id: string, options: ResolvedCaptureOptions) {
        this.page = native(page);
        this.#store = store;
        this.directory = store.directory;
        this.runId = "playwright-typescript:run:" + id;
        this.sequenceId = this.runId + ":sequence:1";
        this.#options = options;
        this.checks = new Checks(this);
    }

    /** Create a trace at an exact directory. Existing traces are preserved by the evidence writer. */
    static async start(directory: string, page: Page, options: EvidenceOptions = {}): Promise<PlaywrightEvidence> {
        page = native(page);
        requireAdapter(!pageRecorders.has(page), "This page already has an evidence recorder.");
        const capture = captureOptions(options.capture);
        const sequenceIndex = options.sequenceIndex ?? 1;
        requireAdapter(Number.isSafeInteger(sequenceIndex) && sequenceIndex > 0, "sequenceIndex must be a positive integer.");
        for (const value of [options.origin, options.testObjective]) {
            requireAdapter(value === undefined || typeof value === "string", "Metadata descriptions must be strings.");
        }
        const id = randomUUID();
        const properties: Properties = {...owned(options.properties ?? {}),
            "evidence.adapter": "testar-evidence-playwright-typescript-adapter", "evidence.adapter_version": VERSION,
            "playwright.initial_url": page.url()};
        if (options.origin !== undefined) {
            properties["evidence.origin"] = options.origin;
        }
        if (options.testObjective !== undefined) {
            properties["evidence.test_objective"] = options.testObjective;
        }
        const store = await JsonlStore.create(directory, {schema_version: 3, evidence_id: "playwright-typescript:evidence:" + id});
        const recorder = new PlaywrightEvidence(page, store, id, capture);
        try {
            await recorder.emit("test_run_started", {id: recorder.runId, producer: "playwright-typescript", source_run: id, properties});
            await recorder.emit("test_sequence_started", {id: recorder.sequenceId, test_run: recorder.runId,
                sequence_index: sequenceIndex, source_sequence: String(sequenceIndex), properties: {}});
            pageRecorders.set(page, recorder);
            return recorder;
        } catch (error) {
            await store.close();
            throw error;
        }
    }

    /** Reserve a timestamped directory so independent executions never overwrite one another. */
    static async startTrace(page: Page, options: EvidenceOptions = {}): Promise<PlaywrightEvidence> {
        const parent = options.evidencePath ?? "target/traces";
        const sut = options.sut ?? "application";
        requireAdapter(typeof sut === "string" && sut.trim(), "Supply a nonblank SUT label.");
        const label = (value: string) => value.replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 40) || "run";
        const timestamp = new Date().toISOString().replace("T", "_").replace(/[.:]/g, "-").replace("Z", "");
        const name = label(sut) + "_" + label(options.testObjective ?? "run") + "_trace-" + timestamp + "-" + randomUUID().slice(0, 8);
        const directory = path.join(parent, name);
        await mkdir(directory, {recursive: false}).catch(async error => {
            if (error.code !== "ENOENT") {
                throw error;
            }
            await mkdir(parent, {recursive: true});
            await mkdir(directory);
        });
        return PlaywrightEvidence.start(directory, page, options);
    }

    get bufferedObservation(): string | null { return this.#pending?.id ?? null; }
    /** Accepted immutable facts only; buffered captures become visible after commitCapture(). */
    get recordedEvidence() { return this.#store.evidence; }

    private async emit<K extends EventType>(type: K, data: EventData[K]): Promise<void> {
        await this.#store.append(evidenceEvent(this.runId + ":event:" + (++this.#events), type, data));
    }

    /** Reject overlapping writes on one page while allowing independent page recorders. */
    async exclusive<T>(operation: () => Promise<T>): Promise<T> {
        requireAdapter(!this.#finished, "This evidence recorder is finished.");
        requireAdapter(!this.#busy, "Wait for the current recording operation on this page.");
        this.#busy = true;
        try {
            return await operation();
        } finally {
            this.#busy = false;
        }
    }

    private async ensureCapture(): Promise<BufferedObservation> {
        if (!this.#pending) {
            this.#observations++;
            this.#pending = {id: this.runId + ":observation:" + this.#observations, index: this.#observations,
                snapshot: await capturePage(this.page, this.#options), bindings: [], scope: "unknown",
                reported: false, oracles: [], artifacts: []};
        }
        return this.#pending;
    }

    private async flush(): Promise<string> {
        const pending = this.#pending;
        requireAdapter(pending, "Capture an observation before committing it.");
        const artifacts = [...pending.artifacts];
        if (pending.snapshot.screenshot) {
            artifacts.push(await this.#store.saveArtifact(pending.snapshot.screenshot, "image/png"));
        }
        await this.emit("observation_recorded", {
            id: pending.id, test_sequence: this.sequenceId, observation_index: pending.index,
            timestamp_micros: pending.snapshot.timestamp,
            recorded_state: {id: pending.id + ":state", properties: pending.snapshot.properties,
                widgets: pending.snapshot.widgets, capture: pending.snapshot.capture},
            available_action_scope: pending.scope, available_actions: pending.bindings, artifacts,
        });
        if (this.#awaitingResult) {
            await this.emit("transition_recorded", {action_execution: this.#awaitingResult, resulting_observation: pending.id});
            this.#awaitingResult = null;
        }
        for (const result of pending.oracles) {
            await this.emit("oracle_result_recorded", result);
        }
        this.#lastObservation = pending.id;
        this.#pending = null;
        return pending.id;
    }

    /** Capture a distinct observation. An existing buffer is committed before the next capture. */
    capture(): Promise<string> {
        return this.exclusive(async () => {
            requireAdapter(!this.#selected, "Report the selected action's outcome before capturing.");
            if (this.#pending) {
                await this.flush();
            }
            return (await this.ensureCapture()).id;
        });
    }

    commitCapture(): Promise<string> {
        return this.exclusive(async () => {
            requireAdapter(!this.#selected, "Report the selected action's outcome before committing.");
            return this.flush();
        });
    }

    async observe(): Promise<string> {
        await this.capture();
        return this.commitCapture();
    }

    /** Describe a caller-reported operation independently from its eventual actual input. */
    description(action: AvailableAction): ActionDescription {
        const locator = action.locator ? String(native(action.locator)) : action.name;
        const parameters = owned(action.parameters ?? {});
        requireAdapter(typeof action.actionType === "string" && action.actionType.length > 0 &&
            typeof action.name === "string" && action.name.length > 0, "Supply an action type and description.");
        return {id: "playwright:available:" + identity([action.actionType, action.name, locator, parameters]),
            action_type: action.actionType, properties: {
                "playwright.description": action.name, "playwright.locator": locator, "playwright.available_parameters": parameters,
            }};
    }

    private async describe(description: ActionDescription): Promise<void> {
        if (!this.#descriptions.has(description.id)) {
            await this.emit("action_described", description);
            this.#descriptions.set(description.id, description);
        }
    }

    /** Attach reported available actions to a buffered capture, optionally reusing supplied widget paths. */
    recordAvailableActions(actions: AvailableAction[], options: {
        scope?: Observation["available_action_scope"]; observation?: string; targetPaths?: Array<string | null>;
    } = {}): Promise<string> {
        return this.exclusive(async () => {
            requireAdapter(!this.#selected, "Report the selected action's outcome first.");
            const scope = options.scope ?? "generated";
            requireAdapter(["generated", "eligible", "unknown"].includes(scope), "Unknown available-action scope.");
            const descriptions = actions.map(action => this.description(action));
            if (options.observation !== undefined) {
                requireAdapter(options.observation === this.#pending?.id, "Use the current buffered observation.");
            } else if (this.#pending) {
                await this.flush();
            }
            const pending = await this.ensureCapture();
            requireAdapter(options.targetPaths === undefined || options.targetPaths.length === actions.length, "Supply one target path per action.");
            const paths = options.targetPaths ?? await targetPaths(this.page, actions.map(action => action.locator));
            const bindings: Observation["available_actions"] = [];
            for (const [index, description] of descriptions.entries()) {
                await this.describe(description);
                const binding = {action_description: description.id, target_widget: this.widgetForPath(paths[index])};
                if (!bindings.some(item => item.action_description === binding.action_description && item.target_widget === binding.target_widget)) {
                    bindings.push(binding);
                }
            }
            pending.bindings = bindings;
            pending.scope = scope;
            pending.reported = true;
            return pending.id;
        });
    }

    private widgetForPath(path: string | null): string | null {
        return path !== null && this.#pending?.snapshot.widgets.some(widget => widget.id === widgetId(path)) ? widgetId(path) : null;
    }

    async isSecret(locator?: Locator | null): Promise<boolean> {
        if (!locator) {
            return true;
        }
        try {
            return await native(locator).evaluateAll(elements => elements.length !== 1 ||
                elements[0] instanceof HTMLInputElement && elements[0].type === "password");
        } catch {
            return true;
        }
    }

    async protectedParameters(locator: Locator | null | undefined, parameters: Properties): Promise<{parameters: Properties; secret: boolean}> {
        const prepared = {...owned(parameters)};
        const input = ["value", "text", "key"].some(name => Object.hasOwn(prepared, name));
        const sensitive = input ? ["value", "text", "key", "arguments"].filter(name => Object.hasOwn(prepared, name)) : [];
        const secret = sensitive.length > 0 && await this.isSecret(locator);
        if (secret) {
            for (const name of sensitive) {
                delete prepared[name];
            }
            prepared["playwright.redacted_parameters"] = sensitive;
        }
        return {parameters: prepared, secret};
    }

    private async select(action: AvailableAction, options: PerformOptions): Promise<string> {
        requireAdapter(!this.#selected, "Report the selected action's outcome first.");
        if (options.availableAction) {
            requireAdapter(action.actionType === options.availableAction.actionType && action.name === options.availableAction.name &&
                String(native(action.locator ?? null)) === String(native(options.availableAction.locator ?? null)),
                "The selected action must match its reported description and locator.");
        }
        const description = this.description(options.availableAction ?? action);
        const pending = await this.ensureCapture();
        requireAdapter(options.sourceObservation === undefined || pending.id === options.sourceObservation, "Use the current buffered observation.");
        let target: string | null;
        if (options.availableAction && pending.reported) {
            const bindings = pending.bindings.filter(binding => binding.action_description === description.id);
            requireAdapter(bindings.length === 1, "The selected action must have one reported binding.");
            target = bindings[0].target_widget;
        } else {
            target = this.widgetForPath(await targetPath(action.locator));
        }
        const protectedData = await this.protectedParameters(action.locator, options.parameters ?? {});
        if (action.locator) {
            protectedData.parameters["playwright.locator"] = String(native(action.locator));
            protectedData.parameters["playwright.target_resolution"] = target ? "captured_dom_path" : "not_captured";
        }
        await this.describe(description);
        if (!pending.bindings.some(binding => binding.action_description === description.id && binding.target_widget === target)) {
            pending.bindings.push({action_description: description.id, target_widget: target});
            // Only explicit caller reports establish generated or eligible scope.
            pending.scope = "unknown";
        }
        const source = await this.flush();
        return this.emitSelection(description.id, target, source, protectedData);
    }

    private async emitSelection(description: string, target: string | null, source: string,
        data: {parameters: Properties; secret: boolean}): Promise<string> {
        const id = this.runId + ":execution:" + (++this.#executions);
        await this.emit("action_selected", {id, test_sequence: this.sequenceId, source_observation: source,
            action_description: description, target_widget: target, parameters: data.parameters});
        this.#selected = {id, ...data};
        return id;
    }

    selectAction(action: AvailableAction, options: PerformOptions = {}): Promise<string> {
        return this.exclusive(() => this.select(action, options));
    }

    /** Select from a committed observation without recapturing or resolving browser targets again. */
    selectRecordedAction(action: AvailableAction, observation: string, parameters: Properties = {}): Promise<string> {
        return this.exclusive(async () => {
            requireAdapter(!this.#selected && !this.#pending && observation === this.#lastObservation, "Use the latest committed observation with no pending operation or capture.");
            const description = this.description(action);
            const bindings = this.recordedEvidence.availableActions(observation).filter(binding => binding.action_description === description.id);
            requireAdapter(bindings.length === 1, "The action must have one reported binding.");
            const protectedData = await this.protectedParameters(action.locator, parameters);
            return this.emitSelection(description.id, bindings[0].target_widget, observation, protectedData);
        });
    }

    private async report(outcome: "returned" | "error", error: string | null = null): Promise<void> {
        requireAdapter(this.#selected, "Select an action before reporting its outcome.");
        const id = this.#selected.id;
        const message = outcome === "error" ? (this.#selected.secret ? "Sensitive input operation failed; details redacted." : error ?? "Operation failed.") : null;
        await this.emit("action_execution_reported", {action_execution: id, outcome, error: message});
        this.#selected = null;
        this.#awaitingResult = outcome === "returned" ? id : null;
    }

    reportActionResult(outcome: "returned" | "error", error: string | null = null): Promise<void> {
        return this.exclusive(() => this.report(outcome, error));
    }

    private async invoke<T>(operation: () => Promise<T>, recordOperations = false, captureResult = true): Promise<T> {
        requireAdapter(this.#selected, "Select an action before invoking it.");
        const execution = this.#selected.id;
        const operations: NativeOperation[] | undefined = recordOperations ? [] : undefined;
        let result!: T;
        let failure: unknown;
        let failed = false;
        try {
            result = await recordingScope.run({recorder: this, operations}, operation);
        } catch (error) {
            failure = error;
            failed = true;
        }
        try {
            await this.report(failed ? "error" : "returned", failed ? errorText(failure) : null);
            if (captureResult || recordOperations) {
                const pending = await this.ensureCapture();
                if (operations) {
                    pending.artifacts.push(await this.#store.saveArtifact(new TextEncoder().encode(JSON.stringify({
                        format: "compound-action-operations", version: 1, action_execution: execution, operations,
                    })), "application/json"));
                }
            }
        } catch (error) {
            this.recordingError = error;
            if (!failed) {
                throw error;
            }
        }
        if (failed) {
            throw failure;
        }
        return result;
    }

    perform<T>(action: AvailableAction, operation: () => Promise<T>, options: PerformOptions = {}): Promise<T> {
        return this.exclusive(async () => {
            requireAdapter(typeof operation === "function", "Supply an operation callback.");
            const parameters = options.recordOperations ? {...options.parameters, "playwright.compound_action": true} : options.parameters;
            await this.select(action, {...options, parameters});
            return this.invoke(operation, options.recordOperations);
        });
    }

    executeSelected<T>(operation: () => Promise<T>): Promise<T> {
        return this.exclusive(() => this.invoke(operation, false, false));
    }

    /** Oracle helpers attach reports to this capture; explicit observation IDs request exact reuse. */
    async oracleObservation(reuse?: string, refresh = false): Promise<string> {
        requireAdapter(!this.#selected, "Report the selected action's outcome before recording an oracle.");
        if (reuse !== undefined) {
            requireAdapter(reuse === this.#pending?.id, "Use the current buffered observation.");
        }
        if (refresh && reuse === undefined && this.#pending) {
            await this.flush();
        }
        if (!this.#pending) {
            await this.ensureCapture();
        }
        return this.#pending!.id;
    }

    async oracleTarget(locator: Locator | null | undefined, property: string | undefined, observation: string): Promise<{target: OracleTarget; details: Properties}> {
        if (!locator) {
            return {target: property ? {target_type: "state_property", observation, property} : {target_type: "observation", observation}, details: {}};
        }
        const widget = this.widgetForPath(await targetPath(locator));
        if (widget) {
            return {target: property ? {target_type: "widget_property", observation, widget, property} : {target_type: "widget", observation, widget}, details: {}};
        }
        return {target: {target_type: "observation", observation}, details: {
            "playwright.requested_locator": String(native(locator)), "playwright.target_resolution": "not_captured",
            ...(property ? {"playwright.requested_property": property} : {}),
        }};
    }

    async recordOracle(result: OracleResult): Promise<void> {
        requireAdapter(this.#pending, "Capture an observation before recording its oracle result.");
        this.#pending.oracles.push(owned(result));
    }

    /** Finish sequence before run and preserve the readable trace prefix on later failures. */
    async finish(reason = "completed"): Promise<void> {
        if (this.#finished) {
            return;
        }
        await this.exclusive(async () => {
            if (!this.#pending && !this.#selected && !this.page.isClosed() && !this.#lastObservation) {
                await this.ensureCapture();
            }
            if (this.#pending && !this.#selected) {
                await this.flush();
            }
            await this.emit("test_sequence_finished", {test_sequence: this.sequenceId, reason});
            await this.emit("test_run_finished", {test_run: this.runId, reason});
            this.#finished = true;
            pageRecorders.delete(this.page);
            await this.#store.close();
        });
    }

    async [Symbol.asyncDispose](): Promise<void> { await this.finish(); }
}
