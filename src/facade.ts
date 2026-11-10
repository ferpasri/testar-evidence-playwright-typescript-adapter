import * as playwright from "playwright";
import type { Page } from "playwright";
import { PlaywrightEvidence } from "./evidence.js";
import { native, rawObjects, pageRecorders } from "./registry.js";
import { recordingScope } from "./scope.js";
import { describeCall, type Kind } from "./actions.js";
import { rememberCss } from "./capture.js";
import { errorText } from "./util.js";
import type { EvidenceOptions } from "./types.js";

interface Subject { runtime: EvidenceRuntime; kind: Kind; page?: Page }
export const subjects = new WeakMap<object, Subject>();

function unwrapArgument(value: unknown, seen = new Set<object>()): unknown {
    if (value && typeof value === "object") {
        if (seen.has(value)) {
            return value;
        }
        seen.add(value);
        if (rawObjects.has(value)) {
            return native(value);
        }
        if (Array.isArray(value)) {
            const mapped = value.map(item => unwrapArgument(item, seen));
            return mapped.some((item, index) => item !== value[index]) ? mapped : value;
        }
        if (Object.getPrototypeOf(value) === Object.prototype) {
            const mapped = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwrapArgument(item, seen)]));
            return Object.keys(mapped).some(key => mapped[key] !== (value as Record<string, unknown>)[key]) ? mapped : value;
        }
    }
    return value;
}

/** Delegate native objects through stable proxies; recording occurs only around supported actions. */
export class EvidenceRuntime {
    #proxies = new WeakMap<object, object>();
    #pages = new Map<Page, Promise<PlaywrightEvidence>>();
    #completed = new WeakMap<Page, PlaywrightEvidence>();
    #callbacks = new WeakMap<object, WeakMap<Function, Map<string, Function>>>();
    constructor(private options: EvidenceOptions = {}) {}

    recorderFor(page: Page): Promise<PlaywrightEvidence> {
        page = native(page);
        const completed = this.#completed.get(page);
        if (completed) {
            return Promise.resolve(completed);
        }
        let recorder = this.#pages.get(page);
        if (!recorder) {
            recorder = pageRecorders.has(page) ? Promise.resolve(pageRecorders.get(page)!) : PlaywrightEvidence.startTrace(page, this.options);
            this.#pages.set(page, recorder);
        }
        return recorder;
    }

    wrap<T extends object>(object: T, kind: Kind, page?: Page): T {
        object = native(object);
        if (this.#proxies.has(object)) {
            return this.#proxies.get(object) as T;
        }
        if (kind === "Page") {
            page = object as unknown as Page;
        }
        const runtime = this;
        const proxy = new Proxy(object, {
            get(target, name) {
                const member = Reflect.get(target, name, target);
                if (typeof name !== "string" || name.startsWith("_")) {
                    return member;
                }
                if (typeof member === "function") {
                    return (...args: unknown[]) => runtime.invoke(target, kind, page, name, member, args);
                }
                const propertyKind = name === "keyboard" ? "Keyboard" : name === "mouse" ? "Mouse" : name === "touchscreen" ? "Touchscreen" : null;
                return propertyKind && member ? runtime.wrap(member, propertyKind, page) : member;
            },
        });
        rawObjects.set(proxy, object);
        subjects.set(proxy, {runtime, kind, page});
        this.#proxies.set(object, proxy);
        return proxy;
    }

    private callback(subject: object, event: string, original: Function, page: Page | undefined): Function {
        let callbacks = this.#callbacks.get(subject);
        if (!callbacks) {
            callbacks = new WeakMap();
            this.#callbacks.set(subject, callbacks);
        }
        let events = callbacks.get(original);
        if (!events) {
            events = new Map();
            callbacks.set(original, events);
        }
        let callback = events.get(event);
        if (!callback) {
            callback = (...args: unknown[]) => Reflect.apply(original, this.#proxies.get(subject), args.map(value =>
                value && typeof value === "object" && typeof (value as Page).mainFrame === "function"
                    ? this.wrap(value, "Page") : value));
            events.set(event, callback);
        }
        void page;
        return callback;
    }

    private result(value: any, subject: object, kind: Kind, page: Page | undefined, method: string, args: unknown[]): any {
        if (value === null || value === undefined) {
            return value;
        }
        let resultKind: Kind | undefined;
        if (kind === "BrowserType") {
            resultKind = method === "launchPersistentContext" ? "Context" :
                ["launch", "connect", "connectOverCDP"].includes(method) ? "Browser" : undefined;
        } else if (kind === "Browser") {
            resultKind = method === "newContext" || method === "contexts" ? "Context" : method === "newPage" ? "Page" : undefined;
        } else if (kind === "Context") {
            resultKind = ["newPage", "pages"].includes(method) ? "Page" : method === "browser" ? "Browser" : undefined;
        }
        if (["locator", "getByAltText", "getByLabel", "getByPlaceholder", "getByRole", "getByTestId", "getByText", "getByTitle",
            "filter", "first", "last", "nth", "and", "or", "all", "owner"].includes(method)) {
            resultKind = "Locator";
        } else if (method === "frameLocator" || method === "contentFrame" && kind === "Locator") {
            resultKind = "FrameLocator";
        } else if (["mainFrame", "frame", "frames", "parentFrame", "childFrames", "ownerFrame"].includes(method) ||
            method === "contentFrame" && kind === "ElementHandle") {
            resultKind = "Frame";
        } else if (["elementHandle", "elementHandles", "$", "$$"].includes(method)) {
            resultKind = "ElementHandle";
        } else if (method === "page") {
            resultKind = "Page";
        } else if (method === "context") {
            resultKind = "Context";
        } else if (method === "waitForEvent" && ["popup", "page"].includes(String(args[0]))) {
            resultKind = "Page";
        }
        if (value === subject) {
            return this.#proxies.get(subject);
        }
        if (Array.isArray(value) && resultKind) {
            return value.map(item => this.wrap(item, resultKind!, page));
        }
        if (resultKind && typeof value === "object") {
            const wrapped = this.wrap(value, resultKind, page);
            if (resultKind === "Locator" && method === "locator" && kind === "Page" && page) {
                rememberCss(page, value, args[0], args[1]);
            }
            return wrapped;
        }
        return value;
    }

    private invoke(subject: object, kind: Kind, page: Page | undefined, method: string, member: Function, arguments_: unknown[]): any {
        const args = arguments_.map(argument => unwrapArgument(argument));
        if (["on", "once", "addListener", "off", "removeListener", "prependListener", "prependOnceListener"].includes(method) &&
            typeof args[0] === "string" && typeof args[1] === "function") {
            args[1] = this.callback(subject, args[0], args[1], page);
        }
        const call = () => Reflect.apply(member, subject, args);
        if (method === "close" && ["Page", "Context", "Browser"].includes(kind)) {
            return (async () => {
                for (const [recordedPage, recorder] of this.#pages) {
                    const matches = kind === "Page" ? recordedPage === subject :
                        kind === "Context" ? recordedPage.context() === subject : recordedPage.context().browser() === subject;
                    if (matches) {
                        const completed = await recorder;
                        await completed.finish();
                        this.#completed.set(recordedPage, completed);
                        this.#pages.delete(recordedPage);
                    }
                }
                return call();
            })();
        }
        const action = page ? describeCall(subject, kind, page, method, args) : null;
        if (action && page) {
            return this.action(page, action, call);
        }
        const result = call();
        if (result && typeof result.then === "function") {
            return result.then(async (value: unknown) => {
                const wrapped = this.result(value, subject, kind, page, method, arguments_);
                if (wrapped && typeof wrapped === "object" && subjects.get(wrapped)?.kind === "Page") {
                    await this.recorderFor(native(wrapped) as Page);
                }
                return wrapped;
            });
        }
        return this.result(result, subject, kind, page, method, arguments_);
    }

    private async action(page: Page, action: NonNullable<ReturnType<typeof describeCall>>, call: () => any): Promise<unknown> {
        const recorder = await this.recorderFor(page);
        const scope = recordingScope.getStore();
        if (scope?.operations && scope.recorder !== recorder) {
            throw new Error("Compound child operations must belong to the same recorded page.");
        }
        if (scope?.recorder === recorder) {
            if (!scope.operations) {
                return call();
            }
            const data = await recorder.protectedParameters(action.locator, action.parameters);
            const index = scope.operations?.length ?? 0;
            // Reserve order before awaiting native execution.
            const item = {index, method: action.name, action_type: action.actionType,
                locator: action.locator ? String(action.locator) : null, parameters: data.parameters,
                outcome: "returned" as "returned" | "error", error: null as string | null};
            scope.operations?.push(item);
            try {
                return await call();
            } catch (error) {
                item.outcome = "error";
                item.error = data.secret ? "Sensitive input operation failed; details redacted." : errorText(error);
                throw error;
            }
        }
        const {parameters, ...description} = action;
        return recorder.perform(description, async () => call(), {parameters});
    }

    async finish(): Promise<void> {
        for (const [page, recorder] of this.#pages) {
            const completed = await recorder;
            await completed.finish();
            this.#completed.set(page, completed);
            this.#pages.delete(page);
        }
    }
}

export function createEvidencePlaywright(options: EvidenceOptions = {}) {
    const runtime = new EvidenceRuntime(options);
    return {
        chromium: runtime.wrap(playwright.chromium, "BrowserType"),
        firefox: runtime.wrap(playwright.firefox, "BrowserType"),
        webkit: runtime.wrap(playwright.webkit, "BrowserType"),
        finish: () => runtime.finish(),
    };
}
const defaults = createEvidencePlaywright();
export const chromium = defaults.chromium;
export const firefox = defaults.firefox;
export const webkit = defaults.webkit;
export const finishEvidence = defaults.finish;

/** Attach the facade to an existing native page, including Playwright Test's page fixture. */
export async function recordPage(page: Page, options: EvidenceOptions = {}): Promise<Page> {
    const runtime = new EvidenceRuntime(options);
    await runtime.recorderFor(page);
    return runtime.wrap(page, "Page");
}

export async function evidenceFor(page: Page): Promise<PlaywrightEvidence> {
    const info = subjects.get(page);
    if (info?.page) {
        return info.runtime.recorderFor(info.page);
    }
    const existing = pageRecorders.get(native(page));
    if (existing) {
        return existing;
    }
    throw new Error("Record this page before requesting its evidence recorder.");
}
