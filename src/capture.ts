import { readFile } from "node:fs/promises";
import type { Page, Locator } from "playwright";
import type { Properties, Widget } from "testar-evidence";
import { native } from "./registry.js";
import { identity, errorText, requireAdapter } from "./util.js";
import type { CaptureOptions } from "./types.js";

const captureScript = await readFile(new URL("./resources/capture.js", import.meta.url), "utf8");
const targetScript = await readFile(new URL("./resources/target.js", import.meta.url), "utf8");
// Playwright's Node API invokes function arguments; a string expression is evaluated as-is.
const captureFunction = new Function("options", "return JSON.stringify((" + captureScript + ")(options));") as (options: Record<string, unknown>) => string;
const targetFunction = new Function("elements", "return (" + targetScript + ")(elements);") as (elements: Element[]) => string | null;
const batchFunction = new Function("elements", "selectors",
    "return selectors.map(selector => (" + targetScript + ")(elements.filter(element => element.matches(selector))));"
) as (elements: Element[], selectors: string[]) => Array<string | null>;
export const cssTargets = new WeakMap<Locator, {page: Page; selector: string}>();
const simpleCss = /^(?:[a-zA-Z][a-zA-Z0-9_-]*)?(?:#[a-zA-Z_][a-zA-Z0-9_-]*|\[[a-zA-Z_][a-zA-Z0-9_-]*=(?:"[^"\\\r\n]*"|'[^'\\\r\n]*')\])$/u;

export function rememberCss(page: Page, locator: Locator, selector: unknown, options: unknown): void {
    if (typeof selector === "string" && simpleCss.test(selector) &&
        (!options || Object.values(options).every(value => value === undefined))) {
        cssTargets.set(native(locator), {page: native(page), selector});
    }
}
export function captureOptions(supplied: CaptureOptions = {}) {
    const options = {
        maxWidgets: supplied.maxWidgets ?? 2000,
        maxStringLength: supplied.maxStringLength ?? 8192,
        maxPropertyCharacters: supplied.maxPropertyCharacters ?? 4194304,
        maxAttributes: supplied.maxAttributes ?? 256,
        computedStyles: [...(supplied.computedStyles ?? ["display", "visibility", "font-size", "font-family", "color", "background-color"])],
        excludedAttributes: [...(supplied.excludedAttributes ?? [])],
        screenshots: supplied.screenshots ?? true,
    };
    for (const [name, maximum] of [["maxWidgets", 5000], ["maxStringLength", 65536],
        ["maxPropertyCharacters", 8388608], ["maxAttributes", 1024]] as const) {
        requireAdapter(Number.isInteger(options[name]) && options[name] > 0 && options[name] <= maximum, "Invalid capture limit: " + name);
    }
    for (const [name, maximum] of [["computedStyles", 64], ["excludedAttributes", 256]] as const) {
        const names = options[name];
        requireAdapter(names.length <= maximum && new Set(names).size === names.length &&
            names.every(value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f-\x9f]/u.test(value)),
            "Invalid property selection: " + name);
    }
    requireAdapter(typeof options.screenshots === "boolean", "screenshots must be boolean.");
    return options;
}
export type ResolvedCaptureOptions = ReturnType<typeof captureOptions>;
export interface BrowserSnapshot {
    timestamp: bigint;
    properties: Properties;
    widgets: Widget[];
    screenshot?: Uint8Array;
    capture: "filtered" | "unavailable";
}

/** Transfer DOM data as one JSON string; screenshot capture is a separate native operation. */
export async function capturePage(page: Page, options: ResolvedCaptureOptions): Promise<BrowserSnapshot> {
    let result: {nodes: Array<{path: string; parent: string | null; properties: Properties}>; properties: Properties};
    const timestamp = BigInt(Date.now()) * 1000n;
    try {
        const json = await page.evaluate(captureFunction, {
            maxWidgets: options.maxWidgets, maxValueCharacters: options.maxStringLength,
            maxTotalCharacters: options.maxPropertyCharacters, maxAttributesPerWidget: options.maxAttributes,
            computedStyles: options.computedStyles, excludedAttributes: options.excludedAttributes,
        });
        requireAdapter(typeof json === "string", "DOM capture must return JSON text.");
        result = JSON.parse(json);
    } catch {
        return {timestamp, widgets: [], capture: "unavailable", properties: {
            "evidence.capture": {area: "Page unavailable during DOM capture", widget_selection: "Unavailable", property_selection: "Unavailable"},
        }};
    }
    const widgets = result.nodes.map(node => ({
        id: widgetId(node.path), parent: node.parent === null ? null : widgetId(node.parent),
        properties: {...node.properties, "playwright.dom.path": node.path},
    }));
    let screenshot: Uint8Array | undefined;
    if (options.screenshots) {
        try {
            screenshot = await page.screenshot({type: "png"});
        } catch (error) {
            result.properties["playwright.capture.screenshot_error"] = errorText(error);
        }
    }
    return {timestamp, widgets, properties: result.properties, screenshot, capture: "filtered"};
}
export function widgetId(path: string): string {
    return "playwright:widget:" + identity(path);
}
export async function targetPath(locator: Locator | null | undefined): Promise<string | null> {
    if (!locator) {
        return null;
    }
    try {
        return await native(locator).evaluateAll(targetFunction);
    } catch {
        return null;
    }
}
/** Resolve simple CSS choices together. Other locator forms keep native Playwright resolution. */
export async function targetPaths(page: Page, locators: Array<Locator | null | undefined>): Promise<Array<string | null>> {
    const paths: Array<string | null> = locators.map(() => null);
    const batches = new Map<string, number[]>();
    const remaining: number[] = [];
    for (const [index, locator] of locators.entries()) {
        if (!locator) {
            continue;
        }
        const target = cssTargets.get(native(locator));
        if (target?.page === page) {
            const indices = batches.get(target.selector) ?? [];
            indices.push(index);
            batches.set(target.selector, indices);
        } else {
            remaining.push(index);
        }
    }
    const selectors = [...batches.keys()];
    for (let offset = 0; offset < selectors.length; offset += 128) {
        const chunk = selectors.slice(offset, offset + 128);
        try {
            const values = await page.locator(chunk.join(", ")).evaluateAll(batchFunction, chunk);
            chunk.forEach((selector, position) => batches.get(selector)!.forEach(index => { paths[index] = values[position]; }));
        } catch {
            chunk.forEach(selector => remaining.push(...batches.get(selector)!));
        }
    }
    for (const index of remaining) {
        paths[index] = await targetPath(locators[index]);
    }
    return paths;
}
