export type * from "./unbash-types.js";
import type { ParsedScript } from "./unbash-types.js";
export declare function parse(source: string): ParsedScript;
export declare function parseRegion(source: string, start: number, end: number, depth?: number): ParsedScript;
