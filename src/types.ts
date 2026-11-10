import type { Locator } from "playwright";
import type { Properties, ObservedValue, Oracle, OracleSeverity, OracleResult } from "testar-evidence";

export interface CaptureOptions {
    maxWidgets?: number;
    maxStringLength?: number;
    maxPropertyCharacters?: number;
    maxAttributes?: number;
    computedStyles?: string[];
    excludedAttributes?: string[];
    screenshots?: boolean;
}
export interface EvidenceOptions {
    evidencePath?: string;
    sut?: string;
    testObjective?: string;
    origin?: string;
    properties?: Properties;
    sequenceIndex?: number;
    capture?: CaptureOptions;
}
/** A caller-reported operation and its planning parameters; these are not an execution. */
export interface AvailableAction {
    actionType: string;
    name: string;
    locator?: Locator | null;
    parameters?: Properties;
}
export interface PerformOptions {
    parameters?: Properties;
    availableAction?: AvailableAction;
    sourceObservation?: string;
    recordOperations?: boolean;
}
export interface OracleReport {
    oracle: Oracle;
    name: string;
    oracleStatus: OracleResult["oracle_status"];
    locator?: Locator | null;
    property?: string;
    expectedValue?: OracleResult["expected_value"];
    observedValue?: ObservedValue;
    oracleDetails?: Properties;
    oracleSeverity?: OracleSeverity;
    observation?: string;
}
export interface OracleEvaluation extends Omit<OracleReport, "oracleStatus" | "observedValue"> {
    assertion: () => unknown | Promise<unknown>;
    observedValue?: () => ObservedValue | Promise<ObservedValue>;
    redact?: boolean;
}
export interface NativeOperation {
    index: number;
    method: string;
    action_type: string;
    locator: string | null;
    parameters: Properties;
    outcome: "returned" | "error";
    error: string | null;
}
