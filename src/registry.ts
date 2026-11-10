import type { Page } from "playwright";
import type { PlaywrightEvidence } from "./evidence.js";

export const rawObjects = new WeakMap<object, object>();
export const pageRecorders = new WeakMap<Page, PlaywrightEvidence>();
export function native<T>(object: T): T {
    return object !== null && (typeof object === "object" || typeof object === "function")
        ? (rawObjects.get(object as object) ?? object) as T : object;
}
