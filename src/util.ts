import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyJson, stringifyJson, JsonNumber, type JsonValue } from "testar-evidence";

export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export function identity(value: unknown): string {
    return createHash("sha256").update(stringifyJson(ordered(value))).digest("hex");
}
export function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
export function requireAdapter(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}
/** Retain supplied arguments as JSON without inspecting Playwright object internals. */
export function argumentData(value: unknown, ancestors = new Set<object>(), depth = 0): JsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "bigint") {
        return value;
    }
    if (typeof value === "number") {
        return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) ? value : {type: "unsupported_number"};
    }
    if (value === undefined) {
        return {type: "undefined"};
    }
    if (value instanceof RegExp) {
        return {type: "regular_expression", pattern: value.source, flags: value.flags};
    }
    if (value instanceof Uint8Array) {
        return {type: "bytes", size: value.length, sha256: createHash("sha256").update(value).digest("hex")};
    }
    if (typeof value !== "object" || !value || depth >= 32 || ancestors.has(value)) {
        return {type: "unsupported_argument"};
    }
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
        return {type: "unsupported_argument"};
    }
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map(item => argumentData(item, ancestors, depth + 1));
        }
        return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, argumentData(item, ancestors, depth + 1)]));
    } finally {
        ancestors.delete(value);
    }
}
export function owned<T>(value: T): T {
    return copyJson(value);
}

function ordered(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(ordered);
    }
    if (value !== null && typeof value === "object" && !(value instanceof JsonNumber)) {
        const record = value as Record<string, unknown>;
        return Object.fromEntries(Object.keys(record).sort().map(name => [name, ordered(record[name])]));
    }
    return value;
}
