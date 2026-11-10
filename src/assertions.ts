import { expect as playwrightExpect } from "playwright/test";
import type { Locator, Page } from "playwright";
import type { ObservedValue, Properties } from "testar-evidence";
import { native, pageRecorders } from "./registry.js";
import { subjects } from "./facade.js";
import { recordingScope } from "./scope.js";
import { argumentData } from "./util.js";
import type { PlaywrightEvidence } from "./evidence.js";
import type { OracleEvaluation } from "./types.js";

type NativeExpect = typeof playwrightExpect;
type Reading = () => Promise<ObservedValue>;
const value = async (operation: () => Promise<unknown>): Promise<ObservedValue> =>
    ({value_status: "value", value: argumentData(await operation())});

async function metadata(recorder: PlaywrightEvidence, subject: Page | Locator, page: boolean, method: string, args: unknown[], negated: boolean) {
    const parameters: Properties = {comparison: method, negated, arguments: argumentData(args)};
    let locator: Locator | null = page ? null : subject as Locator;
    let property: string | undefined;
    let expected: any = args.length > 0 ? argumentData(args[0]) : undefined;
    let read: Reading = async () => ({value_status: "unknown"});
    if (page) {
        const actual = subject as Page;
        if (method === "toHaveTitle") {
            property = "playwright.document.title";
            read = () => value(() => actual.title());
        } else if (method === "toHaveURL") {
            property = "playwright.document.url";
            read = () => value(async () => actual.url());
        }
    } else {
        const actual = subject as Locator;
        if (["toHaveText", "toContainText"].includes(method)) {
            property = "playwright.dom.textContent";
            read = () => value(() => actual.textContent({timeout: 100}));
        } else if (method === "toHaveValue") {
            property = "playwright.dom.value";
            read = () => value(() => actual.inputValue({timeout: 100}));
        } else if (method === "toHaveAttribute" && typeof args[0] === "string") {
            property = "playwright.attribute." + args[0];
            expected = args.length > 1 ? argumentData(args[1]) : undefined;
            read = async () => {
                const result = await actual.getAttribute(args[0] as string, {timeout: 100});
                return result === null ? {value_status: "absent"} : {value_status: "value", value: result};
            };
        } else if (method === "toHaveJSProperty" && typeof args[0] === "string") {
            property = "playwright.dom." + args[0];
            expected = argumentData(args[1]);
            read = () => value(() => actual.evaluate((element, name) => (element as unknown as Record<string, unknown>)[name], args[0] as string, {timeout: 100}));
        } else if (method === "toHaveCSS" && typeof args[0] === "string") {
            property = "playwright.style." + args[0];
            expected = argumentData(args[1]);
            read = () => value(() => actual.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), args[0] as string, {timeout: 100}));
        } else if (["toBeVisible", "toBeHidden"].includes(method)) {
            property = "playwright.dom.visible";
            expected = method === "toBeVisible";
            read = () => value(() => actual.isVisible());
        } else if (["toBeEnabled", "toBeDisabled"].includes(method)) {
            property = "playwright.dom.disabled";
            expected = method === "toBeDisabled";
            read = () => value(() => actual.isDisabled({timeout: 100}));
        } else if (method === "toBeChecked") {
            property = "playwright.dom.checked";
            expected = true;
            read = () => value(() => actual.isChecked({timeout: 100}));
        } else if (method === "toHaveCount") {
            locator = null;
            read = () => value(() => actual.count());
        }
        if (Array.isArray(args[0]) || method === "toHaveValues") {
            locator = null;
            property = undefined;
            read = () => value(() => method === "toHaveValues" ? actual.evaluateAll(elements =>
                elements.map(element => element instanceof HTMLSelectElement ? [...element.selectedOptions].map(option => option.value) : null)) : actual.allTextContents());
        }
    }
    const sensitive = ["toHaveValue", "toHaveValues"].includes(method) ||
        ["toHaveAttribute", "toHaveJSProperty"].includes(method) && args[0] === "value";
    const redact = sensitive && await recorder.isSecret(page ? null : subject as Locator);
    if (redact) {
        delete parameters.arguments;
        parameters["playwright.redacted_parameters"] = ["arguments"];
        expected = undefined;
    }
    return {
        oracle: {id: "playwright:" + method, version: "1", parameters},
        locator, property, expectedValue: expected, observedValue: read, redact,
    };
}

function wrapExpect(factory: NativeExpect): NativeExpect {
    return new Proxy(factory, {
        apply(target, thisArg, arguments_) {
            const actual = arguments_[0];
            const subject = native(actual);
            const info = actual && typeof actual === "object" ? subjects.get(actual) : undefined;
            const isPage = subject && typeof subject.mainFrame === "function";
            const isLocator = subject && typeof subject.page === "function" && typeof subject.count === "function";
            const page: Page | undefined = info?.page ?? (isPage ? subject : isLocator ? subject.page() : undefined);
            const assertions = Reflect.apply(target, thisArg, [subject, ...arguments_.slice(1)]);
            if (!page) {
                return assertions;
            }
            function wrapAssertions(object: any, negated = false): any {
                return new Proxy(object, {
                    get(assertionTarget, name) {
                        const member = Reflect.get(assertionTarget, name, assertionTarget);
                        if (name === "not") {
                            return wrapAssertions(member, !negated);
                        }
                        if (typeof name !== "string" || !name.startsWith("to") || typeof member !== "function") {
                            return member;
                        }
                        return async (...args: unknown[]) => {
                            const recorder = info ? await info.runtime.recorderFor(page!) : pageRecorders.get(page!);
                            if (!recorder || recordingScope.getStore()?.recorder === recorder) {
                                return Reflect.apply(member, assertionTarget, args);
                            }
                            const details = await metadata(recorder, subject, Boolean(isPage), name, args, negated);
                            let result: unknown;
                            const report: OracleEvaluation = {
                                ...details, name: typeof arguments_[1] === "string" ? arguments_[1] : "Playwright " + (negated ? "not " : "") + name,
                                assertion: async () => { result = await Reflect.apply(member, assertionTarget, args); },
                            };
                            await recorder.checks.evaluate(report);
                            return result;
                        };
                    },
                });
            }
            return wrapAssertions(assertions);
        },
        get(target, name, receiver) {
            if (name === "soft") {
                return (actual: unknown, ...args: unknown[]) => Reflect.apply(target.soft, target, [native(actual), ...args]);
            }
            if (name === "configure") {
                return (options: Parameters<NativeExpect["configure"]>[0]) => {
                    const configured = target.configure(options);
                    return options.soft ? configured : wrapExpect(configured);
                };
            }
            return Reflect.get(target, name, receiver);
        },
    }) as NativeExpect;
}

/** Native Playwright assertions with one final oracle result for page and locator subjects. */
export const expect = wrapExpect(playwrightExpect);
