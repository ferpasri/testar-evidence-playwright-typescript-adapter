import { AsyncLocalStorage } from "node:async_hooks";
import type { PlaywrightEvidence } from "./evidence.js";
import type { NativeOperation } from "./types.js";

export interface RecordingScope { recorder: PlaywrightEvidence; operations?: NativeOperation[] }
export const recordingScope = new AsyncLocalStorage<RecordingScope>();
