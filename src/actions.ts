import type { Locator, Page } from "playwright";
import type { Properties } from "testar-evidence";
import { argumentData } from "./util.js";

export type Kind = "BrowserType" | "Browser" | "Context" | "Page" | "Frame" | "FrameLocator" | "Locator" | "ElementHandle" | "Keyboard" | "Mouse" | "Touchscreen";
const elementActions = new Set(["blur", "check", "clear", "click", "dblclick", "dispatchEvent", "dragTo",
    "fill", "focus", "hover", "press", "pressSequentially", "scrollIntoViewIfNeeded", "selectOption",
    "selectText", "setChecked", "setInputFiles", "tap", "type", "uncheck"]);
const pageActions = new Set([...elementActions, "dragAndDrop", "emulateMedia", "goBack", "goForward", "goto", "reload", "setContent", "setViewportSize"]);
const keyboardActions = new Set(["down", "insertText", "press", "type", "up"]);
const mouseActions = new Set(["click", "dblclick", "down", "move", "up", "wheel"]);
export interface ActionCall {
    actionType: string;
    name: string;
    locator: Locator | null;
    parameters: Properties;
}

/** Describe supported native calls without changing or replaying their actual arguments. */
export function describeCall(subject: object, kind: Kind, page: Page, method: string, args: unknown[]): ActionCall | null {
    const supported = kind === "Page" || kind === "Frame" ? pageActions.has(method) :
        kind === "Locator" || kind === "ElementHandle" ? elementActions.has(method) :
        kind === "Keyboard" ? keyboardActions.has(method) :
        kind === "Mouse" ? mouseActions.has(method) : kind === "Touchscreen" && method === "tap";
    if (!supported || args.some(argument => argument && typeof argument === "object" && "trial" in argument && argument.trial === true)) {
        return null;
    }
    let locator: Locator | null = kind === "Locator" ? subject as Locator : null;
    const selectorOffset = (kind === "Page" || kind === "Frame") && elementActions.has(method) ? 1 : 0;
    if (selectorOffset && typeof args[0] === "string") {
        locator = (subject as Page).locator(args[0]);
    } else if (kind === "Keyboard") {
        locator = page.locator(":focus");
    }
    const parameters: Properties = {"playwright.method": kind + "." + method, arguments: argumentData(args)};
    const valueIndex = selectorOffset;
    if (["fill", "type", "pressSequentially", "insertText"].includes(method) && typeof args[valueIndex] === "string") {
        parameters.value = args[valueIndex] as string;
    }
    if (["press", "down", "up"].includes(method) && kind !== "Mouse" && typeof args[valueIndex] === "string") {
        parameters.key = args[valueIndex] as string;
    }
    if (method === "clear") {
        parameters.value = "";
    }
    if (method === "goto") {
        parameters.url = argumentData(args[0]);
    }
    return {actionType: method === "goto" ? "navigate" : method, name: kind + "." + method, locator, parameters};
}
