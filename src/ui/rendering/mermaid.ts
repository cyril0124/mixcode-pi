/** Self-contained terminal renderer for Mermaid diagrams.
 * Ported from https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-markdown/src/mermaid.rs
 */

export type MermaidStyleFn = (text: string) => string;

export interface MermaidStyles {
  border: MermaidStyleFn;
  nodeText: MermaidStyleFn;
  edge: MermaidStyleFn;
  edgeLabel: MermaidStyleFn;
  title: MermaidStyleFn;
}

const MAX_LABEL = 28;
const PAD = 1;
const GAP_X = 3;
const GAP_Y = 2;
const WRAP_WIDTH = 24;
const MAX_LINES = 4;
const LABEL_BREAK_CHARS = new Set(["_", "-", ".", "/"]);
const CONT = "\u0000";
const MAX_NODES = 128;
const MAX_EDGES = 512;
const MAX_GROUPS = 24;
const MAX_GROUP_DEPTH = 6;
const MAX_CANVAS_CELLS = 1 << 21;
const MAX_MEMBERS = 8;
const ENTITY_LOOKAHEAD = 10;
const SEQ_GAP = 5;
const U = 1;
const D = 2;
const L = 4;
const R = 8;
const STY_DOT = 1;
const STY_THICK = 2;
const STY_SOLID = 4;

const identity: MermaidStyleFn = (t) => t;

function defaultStyles(partial?: Partial<MermaidStyles>): MermaidStyles {
  return {
    border: partial?.border ?? identity,
    nodeText: partial?.nodeText ?? identity,
    edge: partial?.edge ?? identity,
    edgeLabel: partial?.edgeLabel ?? identity,
    title: partial?.title ?? identity,
  };
}

function charWidth(c: string): number {
  const cp = c.codePointAt(0) ?? 0;
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function displayWidth(s: string): number {
  let w = 0;
  for (const c of s) w += charWidth(c);
  return w;
}

type Oversize = "width" | "cells";

class OversizeError extends Error {
  constructor(readonly kind: Oversize) {
    super(kind);
  }
}

/** Render mermaid source to ANSI-styled lines. Empty input returns []. */
export function renderMermaidASCII(
  src: string,
  maxWidth?: number,
  styles?: Partial<MermaidStyles>,
): string[] {
  if (src.trim() === "") return [];
  const st = defaultStyles(styles);
  const mw = maxWidth;

  let lines: string[] | null = null;
  let oversize: Oversize | null = null;

  const tryLayout = (fn: () => string[]): void => {
    try {
      lines = fn();
    } catch (e) {
      if (e instanceof OversizeError) oversize = e.kind;
      else throw e;
    }
  };

  const graph = parseGraph(src);
  if (graph) {
    tryLayout(() =>
      graph.groups.length === 0
        ? layoutFlowchart(graph, st, mw)
        : renderGrouped(graph, st, mw),
    );
  } else {
    const state = parseState(src);
    if (state) tryLayout(() => layoutFlowchart(state, st, mw));
    else {
      const cls = parseClass(src);
      if (cls) tryLayout(() => renderClass(cls.graph, cls.infos, st, mw));
      else {
        const er = parseEr(src);
        if (er) tryLayout(() => renderClass(er.graph, er.infos, st, mw));
        else {
          const seq = parseSequence(src);
          if (seq) tryLayout(() => layoutSequence(seq, st, mw));
        }
      }
    }
  }

  if (lines !== null) return lines;
  return fallback(src, st, mw, oversize === "width");
}


type Shape = "rect" | "round" | "diamond";
type Head = "none" | "arrow" | "circle" | "cross" | "triangle" | "diamondFill" | "diamondOpen";
type LineKind = "solid" | "dotted" | "thick";
type Dir = "down" | "up" | "right" | "left";
type Cls = "empty" | "border" | "text" | "edge" | "edgeLabel";

interface Node {
  label: string;
  shape: Shape;
}

interface Edge {
  from: number;
  to: number;
  label: string | null;
  headTo: Head;
  headFrom: Head;
  line: LineKind;
}

interface Group {
  id: string;
  label: string;
  parent: number | null;
}

class Graph {
  nodes: Node[] = [];
  edges: Edge[] = [];
  index = new Map<string, number>();
  groups: Group[] = [];
  nodeGroup: Array<number | null> = [];
  curGroup: number | null = null;
  overCap = false;
  dir: Dir = "down";

  nodeIndex(id: string, label: string | null, shape: Shape): number | null {
    const existing = this.index.get(id);
    if (existing !== undefined) {
      if (label !== null) {
        this.nodes[existing].label = label;
        this.nodes[existing].shape = shape;
      }
      return existing;
    }
    if (this.nodes.length >= MAX_NODES) {
      this.overCap = true;
      return null;
    }
    const i = this.nodes.length;
    this.index.set(id, i);
    this.nodes.push({ label: label ?? id, shape });
    this.nodeGroup.push(this.curGroup);
    return i;
  }

  nodeLabel(id: string, label: string): number | null {
    const existing = this.index.get(id);
    if (existing !== undefined) {
      this.nodes[existing].label = label;
      return existing;
    }
    return this.nodeIndex(id, label, "round");
  }
}

function parseGraph(src: string): Graph | null {
  const statements: string[] = [];
  for (const raw of src.split(/\r?\n/)) splitStatements(raw, statements);
  if (statements.length === 0) return null;
  const header = statements[0]!;
  const headerTokens = header.split(/\s+/).filter(Boolean);
  const kind = (headerTokens[0] ?? "").toLowerCase();
  if (kind !== "graph" && kind !== "flowchart") return null;
  const dirTok = (headerTokens[1] ?? "TB").toUpperCase();
  let dir: Dir = "down";
  if (dirTok === "LR") dir = "right";
  else if (dirTok === "RL") dir = "left";
  else if (dirTok === "BT") dir = "up";

  const graph = new Graph();
  graph.dir = dir;
  const stack: number[] = [];

  for (const st of statements.slice(1)) {
    const firstWord = (st.split(/\s+/).filter(Boolean)[0] ?? "").toLowerCase();
    if (firstWord === "subgraph") {
      if (graph.groups.length >= MAX_GROUPS || stack.length >= MAX_GROUP_DEPTH) return null;
      const rest = st.slice("subgraph".length).trim();
      const { id, label } = parseSubgraphDecl(rest);
      graph.groups.push({ id, label, parent: stack.length ? stack[stack.length - 1]! : null });
      stack.push(graph.groups.length - 1);
      graph.curGroup = stack[stack.length - 1]!;
      continue;
    }
    if (firstWord === "end") {
      stack.pop();
      graph.curGroup = stack.length ? stack[stack.length - 1]! : null;
      continue;
    }
    if (
      firstWord === "classdef" ||
      firstWord === "class" ||
      firstWord === "style" ||
      firstWord === "linkstyle" ||
      firstWord === "click" ||
      firstWord === "direction"
    ) {
      continue;
    }
    parseStatement(st, graph);
    if (graph.overCap) return null;
  }
  if (graph.nodes.length === 0) return null;
  return graph;
}

function parseSubgraphDecl(rest: string): { id: string; label: string } {
  if (rest.startsWith('"')) {
    const q = rest.slice(1);
    const end = q.indexOf('"');
    if (end >= 0) {
      const label = q.slice(0, end);
      return { id: label, label: decodeHtmlEntities(label) };
    }
  }
  const open = rest.indexOf("[");
  if (open >= 0) {
    const id = rest.slice(0, open).trim();
    let label = rest.slice(open + 1);
    if (label.endsWith("]")) label = label.slice(0, -1);
    label = cleanLabel(label.trim());
    if (id && label) return { id, label };
  }
  return { id: rest, label: rest };
}

function splitStatements(line: string, out: string[]): void {
  let cur = "";
  let inQuotes = false;
  const chars = [...line];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (inQuotes) {
      if (c === '"') inQuotes = false;
      cur += c;
    } else if (c === '"') {
      inQuotes = true;
      cur += c;
    } else if (c === "%" && chars[i + 1] === "%") {
      break;
    } else if (c === ";") {
      flushStatement(cur, out);
      cur = "";
    } else {
      cur += c;
    }
  }
  flushStatement(cur, out);
}

function flushStatement(cur: string, out: string[]): void {
  const trimmed = cur.trim();
  if (trimmed) out.push(trimmed);
}

function parseStatement(st: string, graph: Graph): void {
  const chars = [...st];
  let i = 0;
  const first = parseNodeGroup(chars, i, graph);
  if (!first) return;
  let prev = first.group;
  i = first.next;

  while (true) {
    i = skipSpaces(chars, i);
    if (i >= chars.length) break;
    const link = parseLink(chars, i);
    if (!link) break;
    i = skipSpaces(chars, link.next);
    const nextG = parseNodeGroup(chars, i, graph);
    if (!nextG) break;
    i = nextG.next;
    for (const f of prev) {
      for (const t of nextG.group) {
        if (graph.edges.length >= MAX_EDGES) {
          graph.overCap = true;
          return;
        }
        let from = f;
        let to = t;
        let headTo = link.right;
        let headFrom = link.left;
        if (link.left === "arrow" && link.right !== "arrow") {
          from = t;
          to = f;
          headTo = "arrow";
          headFrom = link.right;
        }
        graph.edges.push({ from, to, label: link.label, headTo, headFrom, line: link.line });
      }
    }
    prev = nextG.group;
  }
}

function parseNodeGroup(
  chars: string[],
  start: number,
  graph: Graph,
): { group: number[]; next: number } | null {
  const first = parseNode(chars, start, graph);
  if (!first) return null;
  const group = [first.idx];
  let i = first.next;
  while (true) {
    const j = skipSpaces(chars, i);
    if (chars[j] !== "&") break;
    const next = parseNode(chars, j + 1, graph);
    if (!next) return null;
    group.push(next.idx);
    i = next.next;
  }
  return { group, next: i };
}

function skipSpaces(chars: string[], i: number): number {
  while (i < chars.length && (chars[i] === " " || chars[i] === "\t")) i++;
  return i;
}

function isIdCharRust(c: string): boolean {
  if (c === "_") return true;
  return /\p{L}|\p{N}/u.test(c);
}

function parseNode(
  chars: string[],
  start: number,
  graph: Graph,
): { idx: number; next: number } | null {
  let i = skipSpaces(chars, start);
  const idStart = i;
  while (i < chars.length && isIdCharRust(chars[i]!)) i++;
  if (i === idStart) return null;
  const id = chars.slice(idStart, i).join("");

  let shape: Shape | null = null;
  let label: string | null = null;
  let after = i;
  const c0 = chars[i];
  if (c0 === "[") {
    if (chars[i + 1] === "[") ({ shape, label, after } = readShape(chars, i + 2, "]]", "rect"));
    else if (chars[i + 1] === "(") ({ shape, label, after } = readShape(chars, i + 2, ")]", "round"));
    else ({ shape, label, after } = readShape(chars, i + 1, "]", "rect"));
  } else if (c0 === "(") {
    if (chars[i + 1] === "(") ({ shape, label, after } = readShape(chars, i + 2, "))", "round"));
    else if (chars[i + 1] === "[") ({ shape, label, after } = readShape(chars, i + 2, "])", "round"));
    else ({ shape, label, after } = readShape(chars, i + 1, ")", "round"));
  } else if (c0 === "{") {
    if (chars[i + 1] === "{") ({ shape, label, after } = readShape(chars, i + 2, "}}", "diamond"));
    else ({ shape, label, after } = readShape(chars, i + 1, "}", "diamond"));
  } else if (c0 === ">") {
    ({ shape, label, after } = readShape(chars, i + 1, "]", "rect"));
  }

  const idx = graph.nodeIndex(id, label, shape ?? "rect");
  if (idx === null) return null;
  return { idx, next: after };
}

function readShape(
  chars: string[],
  start: number,
  closer: string,
  shape: Shape,
): { shape: Shape | null; label: string | null; after: number } {
  const closerChars = [...closer];
  let i = start;
  let text = "";
  let j = start;
  while (chars[j] === " " || chars[j] === "\t") j++;
  const quoted = chars[j] === '"';
  let inQuotes = false;
  while (i < chars.length) {
    const c = chars[i]!;
    if (quoted && c === '"') {
      inQuotes = !inQuotes;
      text += c;
      i++;
      continue;
    }
    if (!inQuotes && startsWithSlice(chars, i, closerChars)) {
      return { shape, label: cleanLabel(text), after: i + closerChars.length };
    }
    text += c;
    i++;
  }
  return { shape, label: cleanLabel(text), after: chars.length };
}

function startsWithSlice(chars: string[], i: number, slice: string[]): boolean {
  if (i + slice.length > chars.length) return false;
  for (let k = 0; k < slice.length; k++) if (chars[i + k] !== slice[k]) return false;
  return true;
}

function cleanLabel(raw: string): string {
  const stripped = stripHtmlTags(raw.trim()).trim();
  let unquoted = stripped;
  if (
    (stripped.startsWith('"') && stripped.endsWith('"') && stripped.length >= 2) ||
    (stripped.startsWith("'") && stripped.endsWith("'") && stripped.length >= 2)
  ) {
    unquoted = stripped.slice(1, -1).trim();
  }
  const text =
    unquoted.startsWith("`") && unquoted.endsWith("`") && unquoted.length >= 2
      ? stripMarkdown(unquoted.slice(1, -1).trim())
      : unquoted;
  return decodeHtmlEntities(text);
}

function decodeHtmlEntities(s: string): string {
  if (!s.includes("&")) return s;
  const chars = [...s];
  let out = "";
  let i = 0;
  while (i < chars.length) {
    if (chars[i] !== "&") {
      out += chars[i];
      i++;
      continue;
    }
    const hi = Math.min(i + 1 + ENTITY_LOOKAHEAD, chars.length);
    let semi = -1;
    for (let j = i + 1; j < hi; j++) {
      if (chars[j] === ";") {
        semi = j;
        break;
      }
    }
    let decoded: string | null = null;
    if (semi >= 0) decoded = decodeEntityBody(chars.slice(i + 1, semi).join(""));
    if (decoded !== null && semi >= 0) {
      out += decoded;
      i = semi + 1;
    } else {
      out += "&";
      i++;
    }
  }
  return out;
}

function decodeEntityBody(body: string): string | null {
  switch (body) {
    case "lt":
      return "<";
    case "gt":
      return ">";
    case "amp":
      return "&";
    case "quot":
      return '"';
    case "apos":
      return "'";
    default: {
      if (!body.startsWith("#")) return null;
      const num = body.slice(1);
      let code: number;
      if (num.startsWith("x") || num.startsWith("X")) code = Number.parseInt(num.slice(1), 16);
      else code = Number.parseInt(num, 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null;
      if (code < 32 || (code >= 0x7f && code < 0xa0)) return null;
      try {
        return String.fromCodePoint(code);
      } catch {
        return null;
      }
    }
  }
}

function stripMarkdown(s: string): string {
  const noCode = [...s].filter((c) => c !== "`").join("");
  const noStrong = noCode.replaceAll("**", "").replaceAll("__", "");
  const chars = [...noStrong];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (
      (c === "*" || c === "_") &&
      !(i > 0 && isAlnum(chars[i - 1]!) && i + 1 < chars.length && isAlnum(chars[i + 1]!))
    ) {
      continue;
    }
    out += c;
  }
  return out.trim();
}

function isAlnum(c: string): boolean {
  return /\p{L}|\p{N}/u.test(c);
}

const HTML_FORMAT_TAGS = new Set([
  "b", "strong", "i", "em", "u", "s", "strike", "del", "ins", "mark", "small", "big", "sub",
  "sup", "code", "kbd", "samp", "var", "tt", "span", "font", "q", "abbr", "cite", "pre",
]);

function stripHtmlTags(s: string): string {
  const chars = [...s];
  let out = "";
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "<") {
      const tag = htmlTagAt(chars, i);
      if (tag) {
        const lower = tag.name.toLowerCase();
        if (lower === "br") {
          out += " ";
          i = tag.end;
          continue;
        }
        if (HTML_FORMAT_TAGS.has(lower)) {
          i = tag.end;
          continue;
        }
      }
    }
    out += chars[i];
    i++;
  }
  return out;
}

function htmlTagAt(chars: string[], start: number): { name: string; end: number } | null {
  let i = start + 1;
  if (chars[i] === "/") i++;
  const nameStart = i;
  while (i < chars.length && /[A-Za-z0-9]/.test(chars[i]!)) i++;
  if (i === nameStart) return null;
  const name = chars.slice(nameStart, i).join("");
  while (i < chars.length && chars[i] !== ">") {
    if (chars[i] === "<") return null;
    i++;
  }
  if (chars[i] === ">") return { name, end: i + 1 };
  return null;
}

function isLinkChar(c: string): boolean {
  return c === "-" || c === "." || c === "=" || c === "<" || c === ">";
}

function parseLink(
  chars: string[],
  start: number,
): { left: Head; right: Head; line: LineKind; label: string | null; next: number } | null {
  let i = skipSpaces(chars, start);
  let left: Head = "none";
  const c = chars[i];
  if ((c === "o" || c === "x") && (chars[i + 1] === "-" || chars[i + 1] === "." || chars[i + 1] === "=")) {
    left = c === "o" ? "circle" : "cross";
    i++;
  }
  const opStart = i;
  while (i < chars.length && isLinkChar(chars[i]!)) i++;
  if (i === opStart) return null;
  const op1 = chars.slice(opStart, i).join("");
  if (left === "none" && op1.startsWith("<")) left = "arrow";
  let line = lineKind(op1);
  let right: Head = op1.includes(">") ? "arrow" : "none";
  if (right === "none") {
    const th = trailingHead(chars, i);
    if (th) {
      right = th.head;
      i = th.next;
    }
  }
  if (chars[i] === "|") {
    i++;
    const lStart = i;
    while (i < chars.length && chars[i] !== "|") i++;
    const label = cleanLabel(chars.slice(lStart, i).join(""));
    if (chars[i] === "|") i++;
    return { left, right, line, label: nonEmpty(label), next: i };
  }
  if (right === "none") {
    const textStart = skipSpaces(chars, i);
    let j = textStart;
    while (j < chars.length && !isLinkChar(chars[j]!)) j++;
    if (j < chars.length && j > textStart && isLinkChar(chars[j]!)) {
      const text = chars.slice(textStart, j).join("");
      const op2Start = j;
      while (j < chars.length && isLinkChar(chars[j]!)) j++;
      const op2 = chars.slice(op2Start, j).join("");
      if (op2.includes(">")) right = "arrow";
      else {
        const th = trailingHead(chars, j);
        if (th) {
          right = th.head;
          j = th.next;
        } else right = "none";
      }
      if (line === "solid") line = lineKind(op2);
      return { left, right, line, label: nonEmpty(cleanLabel(text)), next: j };
    }
  }
  return { left, right, line, label: null, next: i };
}

function lineKind(op: string): LineKind {
  if (op.includes("=")) return "thick";
  if (op.includes(".")) return "dotted";
  return "solid";
}

function trailingHead(chars: string[], i: number): { head: Head; next: number } | null {
  const c = chars[i];
  if (c !== "o" && c !== "x") return null;
  const head: Head = c === "o" ? "circle" : "cross";
  const n = chars[i + 1];
  if (n === undefined || n === " " || n === "\t" || n === "|" || n === "&" || n === ";") {
    return { head, next: i + 1 };
  }
  return null;
}

function nonEmpty(s: string): string | null {
  return s === "" ? null : s;
}


function parseState(src: string): Graph | null {
  const statements: string[] = [];
  for (const raw of src.split(/\r?\n/)) splitStatements(raw, statements);
  if (statements.length === 0) return null;
  const header = statements[0]!;
  const firstTok = (header.split(/\s+/).filter(Boolean)[0] ?? "").toLowerCase();
  if (!firstTok.startsWith("statediagram")) return null;

  const graph = new Graph();
  graph.dir = "down";
  let inNote = false;

  for (const st of statements.slice(1)) {
    if (inNote) {
      if (st.toLowerCase() === "end note") inNote = false;
      continue;
    }
    const first = (st.split(/\s+/).filter(Boolean)[0] ?? "").toLowerCase();
    if (first === "direction") {
      const d = (st.split(/\s+/).filter(Boolean)[1] ?? "").toUpperCase();
      if (d === "LR") graph.dir = "right";
      else if (d === "RL") graph.dir = "left";
      else if (d === "BT") graph.dir = "up";
      else graph.dir = "down";
    } else if (first === "note") {
      if (!st.includes(":")) inNote = true;
    } else if (first === "state") {
      if (parseStateDecl(st, graph) === null) return null;
    } else if (
      first === "classdef" || first === "class" || first === "hide" ||
      first === "scale" || first === "}" || first === "--"
    ) {
      // ignore
    } else if (st.includes("-->")) {
      if (parseTransition(st, graph) === null) return null;
    } else {
      if (parseStateDesc(st, graph) === null) return null;
    }
    if (graph.overCap) return null;
  }
  if (graph.nodes.length === 0) return null;
  return graph;
}

function parseStateDecl(st: string, graph: Graph): true | null {
  let rest = st.slice("state".length).trim();
  if (rest.endsWith("{")) rest = rest.slice(0, -1).trim();
  if (!rest) return true;
  if (rest.startsWith('"')) {
    const q = rest.slice(1);
    const end = q.indexOf('"');
    if (end < 0) return null;
    const label = q.slice(0, end);
    const after = q.slice(end + 1).trim();
    let id = label;
    if (after.toLowerCase().startsWith("as")) id = after.slice(2).trim();
    if (graph.nodeLabel(id, decodeHtmlEntities(label)) === null) return null;
    return true;
  }
  let shape: Shape = "round";
  let id = rest;
  let stereotyped = false;
  const pos = rest.indexOf("<<");
  if (pos >= 0) {
    let stereo = rest.slice(pos + 2);
    if (stereo.endsWith(">>")) stereo = stereo.slice(0, -2);
    stereo = stereo.trim();
    if (stereo === "choice") shape = "diamond";
    id = rest.slice(0, pos).trim();
    stereotyped = true;
  }
  if (!id || /\s/.test(id)) return null;
  if (graph.nodeIndex(id, stereotyped ? id : null, shape) === null) return null;
  return true;
}

function parseTransition(st: string, graph: Graph): true | null {
  let rest = st;
  let prev: number | null = null;
  while (rest.includes("-->")) {
    const idx = rest.indexOf("-->");
    const lhs = rest.slice(0, idx);
    const rhs = rest.slice(idx + 3);
    const fromId = lhs.trimEnd().replace(/-+$/, "").trim();
    let from: number;
    if (prev !== null) {
      if (fromId !== "") return null;
      from = prev;
    } else {
      if (!fromId) return null;
      const ep = stateEndpoint(graph, fromId, true);
      if (ep === null) return null;
      from = ep;
    }
    const nextArrow = rhs.indexOf("-->");
    const toPartFull = nextArrow >= 0 ? rhs.slice(0, nextArrow) : rhs;
    const tail = nextArrow >= 0 ? rhs.slice(nextArrow) : "";
    let toPart = toPartFull;
    let label: string | null = null;
    const colon = toPart.indexOf(":");
    if (colon >= 0) {
      label = nonEmpty(decodeHtmlEntities(toPart.slice(colon + 1).trim()));
      toPart = toPart.slice(0, colon);
    }
    const toId = toPart.trimStart().replace(/^>+/, "").trimEnd().replace(/-+$/, "").trim();
    if (!toId) return null;
    const to = stateEndpoint(graph, toId, false);
    if (to === null) return null;
    if (graph.edges.length >= MAX_EDGES) {
      graph.overCap = true;
      return true;
    }
    graph.edges.push({ from, to, label, headTo: "arrow", headFrom: "none", line: "solid" });
    prev = to;
    rest = tail;
    if (!rest.includes("-->")) break;
  }
  return true;
}

function stateEndpoint(graph: Graph, id: string, isSource: boolean): number | null {
  if (id === "[*]") {
    const key = isSource ? "[*]start" : "[*]end";
    return graph.nodeIndex(key, "●", "round");
  }
  return graph.nodeIndex(id, null, "round");
}

function parseStateDesc(st: string, graph: Graph): true | null {
  const colon = st.indexOf(":");
  if (colon >= 0) {
    const id = st.slice(0, colon).trim();
    const desc = st.slice(colon + 1).trim();
    if (!id || /\s/.test(id) || !desc) return null;
    if (graph.nodeLabel(id, decodeHtmlEntities(desc)) === null) return null;
  } else if (!/\s/.test(st)) {
    if (graph.nodeIndex(st, null, "round") === null) return null;
  } else return null;
  return true;
}

const CLASS_OPS: Array<[string, Head, Head, LineKind]> = [
  ["<|--", "triangle", "none", "solid"],
  ["--|>", "none", "triangle", "solid"],
  ["<|..", "triangle", "none", "dotted"],
  ["..|>", "none", "triangle", "dotted"],
  ["*--", "diamondFill", "none", "solid"],
  ["--*", "none", "diamondFill", "solid"],
  ["o--", "diamondOpen", "none", "solid"],
  ["--o", "none", "diamondOpen", "solid"],
  ["<--", "arrow", "none", "solid"],
  ["-->", "none", "arrow", "solid"],
  ["<..", "arrow", "none", "dotted"],
  ["..>", "none", "arrow", "dotted"],
  ["--", "none", "none", "solid"],
  ["..", "none", "none", "dotted"],
];

interface ClassInfo {
  annotation: string | null;
  attrs: string[];
  methods: string[];
}

function emptyClassInfo(): ClassInfo {
  return { annotation: null, attrs: [], methods: [] };
}

function parseClass(src: string): { graph: Graph; infos: ClassInfo[] } | null {
  const statements: string[] = [];
  for (const raw of src.split(/\r?\n/)) splitStatements(raw, statements);
  if (statements.length === 0) return null;
  const firstTok = (statements[0]!.split(/\s+/).filter(Boolean)[0] ?? "").toLowerCase();
  if (!firstTok.startsWith("classdiagram")) return null;

  const graph = new Graph();
  const infos: ClassInfo[] = [];
  let curClass: number | null = null;

  for (const st of statements.slice(1)) {
    if (curClass !== null) {
      if (st === "}") curClass = null;
      else pushMember(infos[curClass]!, st);
      continue;
    }
    const first = (st.split(/\s+/).filter(Boolean)[0] ?? "").toLowerCase();
    if (first === "direction") {
      const d = (st.split(/\s+/).filter(Boolean)[1] ?? "").toUpperCase();
      if (d === "LR") graph.dir = "right";
      else if (d === "RL") graph.dir = "left";
      else if (d === "BT") graph.dir = "up";
      else graph.dir = "down";
      continue;
    }
    if (
      first === "note" || first === "callback" || first === "click" || first === "link" ||
      first === "style" || first === "cssclass" || first === "classdef" || first === "namespace" || first === "}"
    ) continue;
    if (first === "class") {
      let rest = st.slice("class".length).trim();
      let open = false;
      if (rest.endsWith("{")) {
        rest = rest.slice(0, -1).trim();
        open = true;
      }
      if (!rest || /\s/.test(rest)) return null;
      const idx = graph.nodeIndex(rest, null, "rect");
      if (idx === null) return null;
      syncInfos(graph, infos);
      if (open) curClass = idx;
      continue;
    }
    if (st.startsWith("<<")) {
      const restAnn = st.slice(2);
      const end = restAnn.indexOf(">>");
      if (end < 0) return null;
      const ann = restAnn.slice(0, end);
      const name = restAnn.slice(end + 2).trim();
      if (!name || /\s/.test(name)) return null;
      const idx = graph.nodeIndex(name, null, "rect");
      if (idx === null) return null;
      syncInfos(graph, infos);
      infos[idx]!.annotation = ann.trim();
      continue;
    }
    const rel = parseClassRelation(st);
    if (rel) {
      const f = graph.nodeIndex(rel.from, null, "rect");
      if (f === null) return null;
      syncInfos(graph, infos);
      const t = graph.nodeIndex(rel.to, null, "rect");
      if (t === null) return null;
      syncInfos(graph, infos);
      if (graph.edges.length >= MAX_EDGES) return null;
      graph.edges.push({
        from: f, to: t, label: rel.label, headTo: rel.headTo, headFrom: rel.headFrom, line: rel.line,
      });
      continue;
    }
    const colon = st.indexOf(":");
    if (colon >= 0) {
      const id = st.slice(0, colon).trim();
      const member = st.slice(colon + 1).trim();
      if (!id || /\s/.test(id) || !member) return null;
      const idx = graph.nodeIndex(id, null, "rect");
      if (idx === null) return null;
      syncInfos(graph, infos);
      pushMember(infos[idx]!, member);
      continue;
    }
    return null;
  }
  if (graph.nodes.length === 0) return null;
  syncInfos(graph, infos);
  return { graph, infos };
}

function syncInfos(graph: Graph, infos: ClassInfo[]): void {
  while (infos.length < graph.nodes.length) infos.push(emptyClassInfo());
}

function pushMember(info: ClassInfo, raw: string): void {
  if (raw.startsWith("<<")) {
    const rest = raw.slice(2);
    const end = rest.indexOf(">>");
    if (end >= 0) info.annotation = rest.slice(0, end).trim();
    return;
  }
  const member = decodeHtmlEntities(displayGenerics(raw.trim()));
  const list = member.includes("(") ? info.methods : info.attrs;
  if (list.length < MAX_MEMBERS) list.push(member);
  else if (list.length === MAX_MEMBERS) list.push("…");
}

function parseClassRelation(
  st: string,
): { from: string; to: string; headFrom: Head; headTo: Head; line: LineKind; label: string | null } | null {
  const chars = [...st];
  let found: { pos: number; op: string; hf: Head; ht: Head; line: LineKind } | null = null;
  outer: for (let pos = 0; pos < chars.length; pos++) {
    for (const [op, hf, ht, line] of CLASS_OPS) {
      const bytePos = charByte(st, pos);
      if (st.slice(bytePos).startsWith(op)) {
        if (op.startsWith("o") && pos > 0 && isIdCharRust(chars[pos - 1]!)) continue;
        if (op.endsWith("o")) {
          const after = chars[pos + [...op].length];
          if (after !== undefined && isIdCharRust(after)) continue;
        }
        found = { pos, op, hf, ht, line };
        break outer;
      }
    }
  }
  if (!found) return null;
  const lhsRaw = st.slice(0, charByte(st, found.pos)).trim();
  const rhsRaw = st.slice(charByte(st, found.pos) + found.op.length).trim();
  const { rest: lhs, card: cardFrom } = stripCardinalitySuffix(lhsRaw);
  const { rest: rhs0, card: cardTo } = stripCardinalityPrefix(rhsRaw);
  let toId = rhs0;
  let relLabel: string | null = null;
  const colon = rhs0.indexOf(":");
  if (colon >= 0) {
    toId = rhs0.slice(0, colon).trim();
    relLabel = nonEmpty(decodeHtmlEntities(rhs0.slice(colon + 1).trim()));
  } else toId = rhs0.trim();
  if (!lhs || !toId || /\s/.test(lhs) || /\s/.test(toId)) return null;
  const label = nonEmpty([cardFrom, relLabel ?? "", cardTo].filter((s) => s !== "").join(" "));
  return { from: lhs, to: toId, headFrom: found.hf, headTo: found.ht, line: found.line, label };
}

function charByte(s: string, charPos: number): number {
  let i = 0;
  let n = 0;
  for (const c of s) {
    if (n === charPos) return i;
    i += c.length;
    n++;
  }
  return s.length;
}

function stripCardinalitySuffix(s: string): { rest: string; card: string } {
  const t = s.trimEnd();
  if (t.endsWith('"')) {
    const rest = t.slice(0, -1);
    const q = rest.lastIndexOf('"');
    if (q >= 0) return { rest: rest.slice(0, q).trimEnd(), card: rest.slice(q + 1) };
  }
  return { rest: t, card: "" };
}

function stripCardinalityPrefix(s: string): { rest: string; card: string } {
  const t = s.trimStart();
  if (t.startsWith('"')) {
    const rest = t.slice(1);
    const q = rest.indexOf('"');
    if (q >= 0) return { rest: rest.slice(q + 1).trimStart(), card: rest.slice(0, q) };
  }
  return { rest: t, card: "" };
}

function displayGenerics(s: string): string {
  let out = "";
  let open = false;
  for (const c of s) {
    if (c === "~") {
      out += open ? ">" : "<";
      open = !open;
    } else out += c;
  }
  return out;
}

function parseEr(src: string): { graph: Graph; infos: ClassInfo[] } | null {
  const statements: string[] = [];
  for (const raw of src.split(/\r?\n/)) splitStatements(raw, statements);
  if (statements.length === 0) return null;
  const firstTok = statements[0]!.split(/\s+/).filter(Boolean)[0] ?? "";
  if (firstTok.toLowerCase() !== "erdiagram") return null;

  const graph = new Graph();
  const infos: ClassInfo[] = [];
  let curEntity: number | null = null;

  for (const st of statements.slice(1)) {
    if (curEntity !== null) {
      if (st === "}") curEntity = null;
      else pushErAttribute(infos[curEntity]!, st);
      continue;
    }
    const relSplit = splitErRelationship(st);
    if (relSplit) {
      const tokens = relSplit.rel.split(/\s+/).filter(Boolean);
      if (tokens.length !== 3) return null;
      const [lhs, op, rhs] = tokens as [string, string, string];
      const parsed = parseErOp(op);
      if (!parsed) return null;
      const f = erEntity(graph, infos, lhs);
      if (f === null) return null;
      const t = erEntity(graph, infos, rhs);
      if (t === null) return null;
      if (graph.edges.length >= MAX_EDGES) return null;
      const relLabel = relSplit.label !== null ? cleanLabel(relSplit.label) : "";
      const label = nonEmpty([parsed.cardL, relLabel, parsed.cardR].filter((s) => s !== "").join(" "));
      graph.edges.push({ from: f, to: t, label, headTo: "none", headFrom: "none", line: parsed.line });
      continue;
    }
    let decl = st;
    let open = false;
    if (st.endsWith("{")) {
      decl = st.slice(0, -1).trim();
      open = true;
    }
    if (!decl || decl.split(/\s+/).filter(Boolean).length !== 1) return null;
    const idx = erEntity(graph, infos, decl);
    if (idx === null) return null;
    if (open) curEntity = idx;
  }
  if (graph.nodes.length === 0) return null;
  syncInfos(graph, infos);
  return { graph, infos };
}

function erEntity(graph: Graph, infos: ClassInfo[], token: string): number | null {
  let idx: number | null;
  const open = token.indexOf("[");
  if (open >= 0) {
    const id = token.slice(0, open);
    let label = token.slice(open + 1);
    if (label.endsWith("]")) label = label.slice(0, -1);
    label = cleanLabel(label);
    if (!id || !label) return null;
    idx = graph.nodeLabel(id, label);
  } else idx = graph.nodeIndex(token, null, "rect");
  if (idx === null) return null;
  syncInfos(graph, infos);
  return idx;
}

function splitErRelationship(st: string): { rel: string; label: string | null } | null {
  let rel = st;
  let label: string | null = null;
  const colon = st.indexOf(":");
  if (colon >= 0) {
    rel = st.slice(0, colon);
    label = st.slice(colon + 1).trim();
  }
  const hasOp = rel.split(/\s+/).some((t) => parseErOp(t) !== null);
  return hasOp ? { rel, label } : null;
}

function parseErOp(tok: string): { cardL: string; cardR: string; line: LineKind } | null {
  if (![...tok].every((c) => c.charCodeAt(0) < 128) || tok.length !== 6) return null;
  const mid = tok.slice(2, 4);
  let line: LineKind;
  if (mid === "--") line = "solid";
  else if (mid === "..") line = "dotted";
  else return null;
  const cardL = erCard(tok.slice(0, 2));
  const cardR = erCard(tok.slice(4, 6));
  if (!cardL || !cardR) return null;
  return { cardL, cardR, line };
}

function erCard(tok: string): string | null {
  switch (tok) {
    case "|o":
    case "o|":
      return "0..1";
    case "||":
      return "1";
    case "}o":
    case "o{":
      return "0..*";
    case "}|":
    case "|{":
      return "1..*";
    default:
      return null;
  }
}

function pushErAttribute(info: ClassInfo, raw: string): void {
  const parts: string[] = [];
  for (const tok of raw.split(/\s+/).filter(Boolean)) {
    if (tok.startsWith('"')) break;
    parts.push(tok);
  }
  if (parts.length === 0) return;
  const line = decodeHtmlEntities(parts.join(" "));
  if (info.attrs.length < MAX_MEMBERS) info.attrs.push(line);
  else if (info.attrs.length === MAX_MEMBERS) info.attrs.push("…");
}

function renderClass(
  graph: Graph,
  infos: ClassInfo[],
  styles: MermaidStyles,
  maxWidth: number | undefined,
): string[] {
  const extras: NodeExtra[] = graph.nodes.map((node, i) => {
    const info = infos[i]!;
    const title: string[] = [];
    if (info.annotation) title.push(`«${info.annotation}»`);
    title.push(displayGenerics(node.label));
    return { kind: "compartments" as const, sections: [title, info.attrs.slice(), info.methods.slice()] };
  });
  const canvas = layoutCanvas(graph, extras, maxWidth);
  if (graph.dir === "up") canvas.flipVertical();
  else if (graph.dir === "left") canvas.flipHorizontal();
  return canvas.toLines(styles);
}


class Canvas {
  w: number;
  h: number;
  ch: string[];
  cls: Cls[];
  mask: number[];
  style: number[];
  occupied: boolean[];
  curStyle = STY_SOLID;

  constructor(w: number, h: number) {
    const n = w * h;
    this.w = w;
    this.h = h;
    this.ch = Array(n).fill(" ");
    this.cls = Array(n).fill("empty");
    this.mask = Array(n).fill(0);
    this.style = Array(n).fill(0);
    this.occupied = Array(n).fill(false);
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  set(x: number, y: number, c: string, cls: Cls): void {
    if (x >= this.w || y >= this.h) return;
    const i = this.idx(x, y);
    this.ch[i] = c;
    this.cls[i] = cls;
  }

  addBits(x: number, y: number, bits: number): void {
    if (x >= this.w || y >= this.h) return;
    const i = this.idx(x, y);
    if (this.occupied[i]) return;
    this.mask[i]! |= bits;
    this.style[i]! |= this.curStyle;
    if (this.cls[i] !== "border") this.cls[i] = "edge";
  }

  blit(sub: Canvas, ox: number, oy: number): void {
    for (let sy = 0; sy < sub.h; sy++) {
      for (let sx = 0; sx < sub.w; sx++) {
        const x = ox + sx;
        const y = oy + sy;
        if (x >= this.w || y >= this.h) continue;
        const si = sub.idx(sx, sy);
        const di = this.idx(x, y);
        this.ch[di] = sub.ch[si]!;
        this.cls[di] = sub.cls[si]!;
        this.style[di] = sub.style[si]!;
        this.occupied[di] = true;
      }
    }
  }

  junction(x: number, y: number, bits: number): void {
    if (x >= this.w || y >= this.h) return;
    const i = this.idx(x, y);
    this.mask[i]! |= bits;
    if (this.cls[i] !== "border") this.cls[i] = "edge";
  }

  segV(x: number, y0: number, y1: number): void {
    const a = Math.min(y0, y1);
    const b = Math.max(y0, y1);
    for (let y = a; y <= b; y++) {
      let bits = 0;
      if (y > a) bits |= U;
      if (y < b) bits |= D;
      this.addBits(x, y, bits);
    }
  }

  segH(y: number, x0: number, x1: number): void {
    const a = Math.min(x0, x1);
    const b = Math.max(x0, x1);
    for (let x = a; x <= b; x++) {
      let bits = 0;
      if (x > a) bits |= L;
      if (x < b) bits |= R;
      this.addBits(x, y, bits);
    }
  }

  finalizeMask(): void {
    for (let i = 0; i < this.ch.length; i++) {
      if (this.mask[i] !== 0 && this.ch[i] === " ") {
        const c = maskChar(this.mask[i]!);
        const sty = this.style[i]!;
        this.ch[i] = sty === STY_DOT ? dottedChar(c) : sty === STY_THICK ? thickChar(c) : c;
      }
    }
  }

  flipVertical(): void {
    for (let y = 0; y < Math.floor(this.h / 2); y++) {
      const y2 = this.h - 1 - y;
      for (let x = 0; x < this.w; x++) {
        const i = this.idx(x, y);
        const j = this.idx(x, y2);
        [this.ch[i], this.ch[j]] = [this.ch[j]!, this.ch[i]!];
        [this.cls[i], this.cls[j]] = [this.cls[j]!, this.cls[i]!];
      }
    }
    for (let i = 0; i < this.ch.length; i++) this.ch[i] = flipGlyphV(this.ch[i]!);
  }

  flipHorizontal(): void {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < Math.floor(this.w / 2); x++) {
        const x2 = this.w - 1 - x;
        const i = this.idx(x, y);
        const j = this.idx(x2, y);
        [this.ch[i], this.ch[j]] = [this.ch[j]!, this.ch[i]!];
        [this.cls[i], this.cls[j]] = [this.cls[j]!, this.cls[i]!];
      }
    }
    for (let i = 0; i < this.ch.length; i++) this.ch[i] = flipGlyphH(this.ch[i]!);
    for (let y = 0; y < this.h; y++) {
      let x = 0;
      while (x < this.w) {
        const cls = this.cls[this.idx(x, y)]!;
        if (cls === "text" || cls === "edgeLabel") {
          const start = this.idx(x, y);
          while (x < this.w && this.cls[this.idx(x, y)] === cls) x++;
          const end = this.idx(x, y);
          const slice = this.ch.slice(start, end).reverse();
          for (let k = 0; k < slice.length; k++) this.ch[start + k] = slice[k]!;
        } else x++;
      }
    }
  }

  toLines(styles: MermaidStyles): string[] {
    const lines: string[] = [];
    for (let y = 0; y < this.h; y++) {
      let last = this.w;
      for (let x = this.w - 1; x >= 0; x--) {
        const c = this.ch[this.idx(x, y)]!;
        if (c !== " " && c !== CONT) {
          last = x + 1;
          break;
        }
      }
      let run = "";
      let runCls: Cls = "empty";
      let out = "";
      const flush = () => {
        if (!run) return;
        out += styleFor(runCls, styles)(run);
        run = "";
      };
      for (let x = 0; x < last; x++) {
        const i = this.idx(x, y);
        const c = this.ch[i]!;
        if (c === CONT) continue;
        const cls = this.cls[i]!;
        if (cls !== runCls && run) flush();
        runCls = cls;
        run += c;
      }
      flush();
      lines.push(out.replace(/[ \t]+$/, ""));
    }
    return lines;
  }
}

function styleFor(cls: Cls, styles: MermaidStyles): MermaidStyleFn {
  switch (cls) {
    case "border":
      return styles.border;
    case "text":
      return styles.nodeText;
    case "edge":
      return styles.edge;
    case "edgeLabel":
      return styles.edgeLabel;
    default:
      return identity;
  }
}

function maskChar(mask: number): string {
  if (mask === 0) return " ";
  if (mask === U || mask === D || mask === (U | D)) return "│";
  if (mask === L || mask === R || mask === (L | R)) return "─";
  if (mask === (D | R)) return "┌";
  if (mask === (D | L)) return "┐";
  if (mask === (U | R)) return "└";
  if (mask === (U | L)) return "┘";
  if (mask === (U | D | R)) return "├";
  if (mask === (U | D | L)) return "┤";
  if (mask === (D | L | R)) return "┬";
  if (mask === (U | L | R)) return "┴";
  return "┼";
}

function dottedChar(c: string): string {
  if (c === "─") return "╌";
  if (c === "│") return "╎";
  return c;
}

function thickChar(c: string): string {
  switch (c) {
    case "─": return "━";
    case "│": return "┃";
    case "┌": return "┏";
    case "┐": return "┓";
    case "└": return "┗";
    case "┘": return "┛";
    case "├": return "┣";
    case "┤": return "┫";
    case "┬": return "┳";
    case "┴": return "┻";
    case "┼": return "╋";
    default: return c;
  }
}

function flipGlyphV(c: string): string {
  switch (c) {
    case "┌": return "└";
    case "└": return "┌";
    case "┐": return "┘";
    case "┘": return "┐";
    case "┏": return "┗";
    case "┗": return "┏";
    case "┓": return "┛";
    case "┛": return "┓";
    case "╭": return "╰";
    case "╰": return "╭";
    case "╮": return "╯";
    case "╯": return "╮";
    case "┬": return "┴";
    case "┴": return "┬";
    case "┳": return "┻";
    case "┻": return "┳";
    case "▼": return "▲";
    case "▲": return "▼";
    case "▽": return "△";
    case "△": return "▽";
    default: return c;
  }
}

function flipGlyphH(c: string): string {
  switch (c) {
    case "┌": return "┐";
    case "┐": return "┌";
    case "└": return "┘";
    case "┘": return "└";
    case "┏": return "┓";
    case "┓": return "┏";
    case "┗": return "┛";
    case "┛": return "┗";
    case "╭": return "╮";
    case "╮": return "╭";
    case "╰": return "╯";
    case "╯": return "╰";
    case "├": return "┤";
    case "┤": return "├";
    case "┣": return "┫";
    case "┫": return "┣";
    case "▶": return "◄";
    case "◄": return "▶";
    case "▷": return "◁";
    case "◁": return "▷";
    default: return c;
  }
}

interface Placed {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  rank: number;
}

interface NodeSizes {
  boxW: number[];
  boxH: number[];
  layW: number[];
  layH: number[];
  extraH: number[];
  selfLabelW: number[];
}

type NodeExtra =
  | { kind: "plain" }
  | { kind: "frame"; sub: Canvas }
  | { kind: "compartments"; sections: string[][] };

function layoutFlowchart(graph: Graph, styles: MermaidStyles, maxWidth: number | undefined): string[] {
  const extras: NodeExtra[] = graph.nodes.map(() => ({ kind: "plain" }));
  const canvas = layoutCanvas(graph, extras, maxWidth);
  if (graph.dir === "up") canvas.flipVertical();
  else if (graph.dir === "left") canvas.flipHorizontal();
  return canvas.toLines(styles);
}

function layoutCanvas(graph: Graph, extras: NodeExtra[], maxWidth: number | undefined): Canvas {
  const n = graph.nodes.length;
  if (n === 0) throw new OversizeError("cells");

  const ranks = computeRanks(graph);
  const maxRank = ranks.reduce((a, b) => Math.max(a, b), 0);
  const byRank: number[][] = Array.from({ length: maxRank + 1 }, () => []);
  ranks.forEach((r, idx) => byRank[r]!.push(idx));
  orderRanks(byRank, graph.edges, ranks);

  const wrapped = graph.nodes.map((node) => wrapLabel(node.label, WRAP_WIDTH, MAX_LINES));
  const boxW = Array.from({ length: n }, (_, i) => {
    const ex = extras[i]!;
    if (ex.kind === "frame") {
      const titleW = displayWidth(fitLabel(graph.nodes[i]!.label, WRAP_WIDTH));
      return Math.max(ex.sub.w + 2, titleW + 4);
    }
    if (ex.kind === "compartments") {
      let max = 1;
      for (const sec of ex.sections) for (const l of sec) max = Math.max(max, displayWidth(l));
      return Math.max(1, max) + 2 * PAD + 2;
    }
    let max = 1;
    for (const l of wrapped[i]!) max = Math.max(max, displayWidth(l));
    return Math.max(1, max) + 2 * PAD + 2;
  });
  const boxH = Array.from({ length: n }, (_, i) => {
    const ex = extras[i]!;
    if (ex.kind === "frame") return ex.sub.h + 2;
    if (ex.kind === "compartments") {
      const filled = ex.sections.filter((s) => s.length > 0).length;
      const sum = ex.sections.reduce((a, s) => a + s.length, 0);
      return sum + Math.max(0, filled - 1) + 2;
    }
    return wrapped[i]!.length + 2;
  });

  const extraH = Array(n).fill(0) as number[];
  const selfLabelW = Array(n).fill(0) as number[];
  for (const e of graph.edges) {
    if (e.from === e.to) {
      extraH[e.from] = 2;
      if (e.label) selfLabelW[e.from] = Math.max(selfLabelW[e.from]!, Math.min(displayWidth(e.label), MAX_LABEL));
    }
  }
  for (let i = 0; i < n; i++) if (extraH[i]! > 0) boxW[i] = Math.max(boxW[i]!, 7);
  const layW = Array.from({ length: n }, (_, i) => boxW[i]! + (selfLabelW[i]! > 0 ? 2 * (selfLabelW[i]! + 3) : 0));
  const layH = Array.from({ length: n }, (_, i) => boxH[i]! + extraH[i]!);
  const sizes: NodeSizes = { boxW, boxH, layW, layH, extraH, selfLabelW };

  const placed: Placed[] = Array.from({ length: n }, () => ({
    x: 0, y: 0, w: 0, h: 0, cx: 0, cy: 0, rank: 0,
  }));

  const vertical = graph.dir === "down" || graph.dir === "up";
  const plan = vertical
    ? placeTd(ranks, maxRank, byRank, sizes, graph, placed)
    : placeLr(ranks, maxRank, byRank, sizes, graph, placed);
  const [canvasW, canvasH] = plan.canvas;

  if (maxWidth !== undefined && canvasW > maxWidth) throw new OversizeError("width");
  if (canvasW * canvasH > MAX_CANVAS_CELLS) throw new OversizeError("cells");

  const canvas = new Canvas(canvasW, canvasH);
  for (let idx = 0; idx < n; idx++) {
    const ex = extras[idx]!;
    if (ex.kind === "frame") drawFrame(canvas, placed[idx]!, graph.nodes[idx]!.label, ex.sub);
    else if (ex.kind === "compartments") drawClassBox(canvas, placed[idx]!, ex.sections);
    else drawBox(canvas, placed[idx]!, wrapped[idx]!, graph.nodes[idx]!.shape);
  }
  graph.edges.forEach((edge, i) => {
    canvas.curStyle = edge.line === "solid" ? STY_SOLID : edge.line === "dotted" ? STY_DOT : STY_THICK;
    if (edge.from === edge.to) {
      routeSelf(canvas, placed[edge.from]!, edge);
      return;
    }
    const from = placed[edge.from]!;
    const to = placed[edge.to]!;
    const adjacent = to.rank === from.rank + 1;
    const bus = plan.bandEnd[from.rank]! + plan.edgeBus[i]!;
    const lane = plan.laneBase + plan.edgeLane[i]!;
    if (vertical && adjacent) routeForward(canvas, from, to, edge, bus);
    else if (vertical && !adjacent) routeBack(canvas, from, to, edge, lane);
    else if (!vertical && adjacent) routeForwardLr(canvas, from, to, edge, bus);
    else routeBackLr(canvas, from, to, edge, lane);
  });
  canvas.finalizeMask();
  return canvas;
}

type Item = { kind: "node"; n: number } | { kind: "group"; g: number };

function itemKey(it: Item): string {
  return it.kind === "node" ? `n${it.n}` : `g${it.g}`;
}

function renderGrouped(graph: Graph, styles: MermaidStyles, maxWidth: number | undefined): string[] {
  const proxy = new Map<number, number>();
  graph.groups.forEach((g, gi) => {
    const ni = graph.index.get(g.id);
    if (ni !== undefined) proxy.set(ni, gi);
  });

  const groupChain = (g: number | null): number[] => {
    const chain: number[] = [];
    let cur = g;
    while (cur !== null) {
      chain.push(cur);
      cur = graph.groups[cur]!.parent;
    }
    chain.reverse();
    return chain;
  };
  const endpoint = (n: number): { item: Item; chain: number[] } => {
    const gi = proxy.get(n);
    if (gi !== undefined) return { item: { kind: "group", g: gi }, chain: groupChain(graph.groups[gi]!.parent) };
    return { item: { kind: "node", n }, chain: groupChain(graph.nodeGroup[n]!) };
  };

  const scopeEdges = new Map<string, Array<{ f: Item; t: Item; ei: number }>>();
  const scopeKey = (s: number | null) => (s === null ? "root" : String(s));
  const referenced = Array(graph.groups.length).fill(false) as boolean[];

  graph.edges.forEach((e, ei) => {
    const a = endpoint(e.from);
    const b = endpoint(e.to);
    let k = 0;
    while (k < a.chain.length && k < b.chain.length && a.chain[k] === b.chain[k]) k++;
    const scope = k === 0 ? null : a.chain[k - 1]!;
    const f: Item = a.chain.length > k ? { kind: "group", g: a.chain[k]! } : a.item;
    const t: Item = b.chain.length > k ? { kind: "group", g: b.chain[k]! } : b.item;
    if (f.kind === "group") referenced[f.g] = true;
    if (t.kind === "group") referenced[t.g] = true;
    const key = scopeKey(scope);
    if (!scopeEdges.has(key)) scopeEdges.set(key, []);
    scopeEdges.get(key)!.push({ f, t, ei });
  });

  const directNodes = new Map<string, number[]>();
  graph.nodeGroup.forEach((g, ni) => {
    if (!proxy.has(ni)) {
      const key = scopeKey(g);
      if (!directNodes.has(key)) directNodes.set(key, []);
      directNodes.get(key)!.push(ni);
    }
  });

  const keep = Array(graph.groups.length).fill(false) as boolean[];
  for (let gi = graph.groups.length - 1; gi >= 0; gi--) {
    const hasNodes = (directNodes.get(scopeKey(gi)) ?? []).length > 0;
    const hasChildren = graph.groups.some((g, c) => g.parent === gi && keep[c]);
    keep[gi] = hasNodes || hasChildren || referenced[gi]!;
  }

  const canvas = buildScope(graph, null, scopeEdges, directNodes, keep, maxWidth);
  if (graph.dir === "up") canvas.flipVertical();
  else if (graph.dir === "left") canvas.flipHorizontal();
  return canvas.toLines(styles);
}

function buildScope(
  graph: Graph,
  scope: number | null,
  scopeEdges: Map<string, Array<{ f: Item; t: Item; ei: number }>>,
  directNodes: Map<string, number[]>,
  keep: boolean[],
  maxWidth: number | undefined,
): Canvas {
  const scopeKey = (s: number | null) => (s === null ? "root" : String(s));
  const items: Item[] = [];
  for (const n of directNodes.get(scopeKey(scope)) ?? []) items.push({ kind: "node", n });
  for (let gi = 0; gi < graph.groups.length; gi++) {
    if (graph.groups[gi]!.parent === scope && keep[gi]) items.push({ kind: "group", g: gi });
  }
  if (items.length === 0) return new Canvas(1, 1);

  const indexOf = new Map<string, number>();
  const nodes: Node[] = [];
  const extras: NodeExtra[] = [];
  for (const item of items) {
    indexOf.set(itemKey(item), nodes.length);
    if (item.kind === "node") {
      nodes.push({ label: graph.nodes[item.n]!.label, shape: graph.nodes[item.n]!.shape });
      extras.push({ kind: "plain" });
    } else {
      const sub = buildScope(graph, item.g, scopeEdges, directNodes, keep, undefined);
      nodes.push({ label: graph.groups[item.g]!.label, shape: "rect" });
      extras.push({ kind: "frame", sub });
    }
  }

  const edges: Edge[] = [];
  for (const { f, t, ei } of scopeEdges.get(scopeKey(scope)) ?? []) {
    const fi = indexOf.get(itemKey(f));
    const ti = indexOf.get(itemKey(t));
    if (fi === undefined || ti === undefined) continue;
    const e = graph.edges[ei]!;
    edges.push({ from: fi, to: ti, label: e.label, headTo: e.headTo, headFrom: e.headFrom, line: e.line });
  }

  const synth = new Graph();
  synth.nodes = nodes;
  synth.edges = edges;
  synth.dir = graph.dir;
  return layoutCanvas(synth, extras, maxWidth);
}


function drawClassBox(canvas: Canvas, p: Placed, sections: string[][]): void {
  drawBox(canvas, p, [], "rect");
  const inner = Math.max(1, p.w - 2 * PAD - 2);
  let row = p.y + 1;
  let first = true;
  sections.forEach((section, si) => {
    if (section.length === 0) return;
    if (!first) {
      canvas.set(p.x, row, "├", "border");
      for (let x = p.x + 1; x < p.x + p.w - 1; x++) canvas.set(x, row, "─", "border");
      canvas.set(p.x + p.w - 1, row, "┤", "border");
      row++;
    }
    first = false;
    for (const line of section) {
      const text = fitLabel(line, inner);
      const tx = si === 0
        ? p.x + 1 + PAD + Math.floor((inner - displayWidth(text)) / 2)
        : p.x + 1 + PAD;
      drawSeqText(canvas, text, tx, row, "text");
      row++;
    }
  });
}

function drawFrame(canvas: Canvas, p: Placed, title: string, sub: Canvas): void {
  drawBox(canvas, p, [], "rect");
  const t = fitLabel(title, Math.max(0, p.w - 4));
  drawSeqText(canvas, ` ${t} `, p.x + 1, p.y, "text");
  const ox = p.x + 1 + Math.floor((p.w - 2 - sub.w) / 2);
  const oy = p.y + 1 + Math.floor((p.h - 2 - sub.h) / 2);
  canvas.blit(sub, ox, oy);
}

function busSpansTd(
  graph: Graph,
  ranks: number[],
  centers: number[],
  r: number,
  exact: boolean,
): Array<[number, number, number, number, number]> {
  const out: Array<[number, number, number, number, number]> = [];
  graph.edges.forEach((e, i) => {
    const jogs = exact
      ? centers[e.from] !== centers[e.to]
      : Math.abs(centers[e.from]! - centers[e.to]!) > 1;
    if (e.from !== e.to && ranks[e.from] === r && ranks[e.to] === r + 1 && jogs) {
      const a = Math.min(centers[e.from]!, centers[e.to]!);
      const b = Math.max(centers[e.from]!, centers[e.to]!);
      out.push([a, b, e.from, e.to, i]);
    }
  });
  return out;
}

function laneSpans(
  graph: Graph,
  ranks: number[],
  placed: Placed[],
  vertical: boolean,
): Array<[number, number, number, number, number]> {
  const out: Array<[number, number, number, number, number]> = [];
  graph.edges.forEach((e, i) => {
    if (e.from === e.to || ranks[e.to] === ranks[e.from]! + 1) return;
    const pf = placed[e.from]!;
    const pt = placed[e.to]!;
    const a = vertical ? Math.min(pf.cy, pt.cy) : Math.min(pf.cx, pt.cx);
    const b = vertical ? Math.max(pf.cy, pt.cy) : Math.max(pf.cx, pt.cx);
    out.push([a, b, e.from, e.to, i]);
  });
  return out;
}

interface RoutePlan {
  canvas: [number, number];
  bandEnd: number[];
  edgeBus: number[];
  laneBase: number;
  edgeLane: number[];
}

function placeTd(
  ranks: number[],
  maxRank: number,
  byRank: number[][],
  sizes: NodeSizes,
  graph: Graph,
  placed: Placed[],
): RoutePlan {
  const centers = assignPositions(byRank, sizes.layW, GAP_X, graph.edges, ranks);
  const edgeBus = Array(graph.edges.length).fill(0) as number[];
  const busTracks = Array(maxRank + 1).fill(0) as number[];
  for (let r = 0; r < maxRank; r++) {
    const spans = busSpansTd(graph, ranks, centers, r, false);
    if (spans.length === 0) continue;
    const { assigned, count } = assignTracks(spans);
    for (const [idx, slot] of assigned) edgeBus[idx] = slot;
    busTracks[r] = count;
  }

  const rankH = byRank.map((row) =>
    row.reduce((m, i) => Math.max(m, sizes.boxH[i]! + sizes.extraH[i]!), 3),
  );
  const rankY = Array(maxRank + 1).fill(0) as number[];
  for (let r = 1; r <= maxRank; r++) {
    const gap = Math.max(GAP_Y, busTracks[r - 1]! + 1);
    rankY[r] = rankY[r - 1]! + rankH[r - 1]! + gap;
  }
  const canvasH = rankY[maxRank]! + rankH[maxRank]!;
  const bandEnd = Array.from({ length: maxRank + 1 }, (_, r) => rankY[r]! + rankH[r]!);

  let diagramW = 1;
  byRank.forEach((row, r) => {
    for (const idx of row) {
      const w = sizes.boxW[idx]!;
      const h = sizes.boxH[idx]!;
      const cx = centers[idx]!;
      const x = Math.max(0, cx - Math.floor(w / 2));
      const y = rankY[r]! + Math.floor((rankH[r]! - h - sizes.extraH[idx]!) / 2);
      placed[idx] = { x, y, w, h, cx, cy: y + Math.floor(h / 2), rank: r };
      diagramW = Math.max(diagramW, x + w);
      if (sizes.extraH[idx]! > 0 && sizes.selfLabelW[idx]! > 0) {
        diagramW = Math.max(diagramW, x + w + 2 + sizes.selfLabelW[idx]!);
      }
    }
  });

  let contentW = diagramW;
  for (const e of graph.edges) {
    if (e.from === e.to || !e.label) continue;
    const lw = Math.min(displayWidth(e.label), MAX_LABEL);
    if (ranks[e.to] === ranks[e.from]! + 1) contentW = Math.max(contentW, placed[e.to]!.cx + 2 + lw);
    else contentW = Math.max(contentW, diagramW + lw + 1);
  }

  const edgeLane = Array(graph.edges.length).fill(0) as number[];
  const lanes = laneSpans(graph, ranks, placed, true);
  let canvasW: number;
  let laneBase: number;
  if (lanes.length === 0) {
    canvasW = contentW;
    laneBase = 0;
  } else {
    const { assigned, count } = assignTracks(lanes);
    for (const [idx, slot] of assigned) edgeLane[idx] = slot;
    canvasW = contentW + 1 + count;
    laneBase = contentW + 1;
  }
  return { canvas: [canvasW, canvasH], bandEnd, edgeBus, laneBase, edgeLane };
}

function placeLr(
  ranks: number[],
  maxRank: number,
  byRank: number[][],
  sizes: NodeSizes,
  graph: Graph,
  placed: Placed[],
): RoutePlan {
  const colW = byRank.map((row) => row.reduce((m, i) => Math.max(m, sizes.boxW[i]!), 0));
  let maxLabel = 0;
  for (const e of graph.edges) {
    if (e.from === e.to || ranks[e.to] === ranks[e.from]! + 1) {
      if (e.label) maxLabel = Math.max(maxLabel, Math.min(displayWidth(e.label), MAX_LABEL));
    }
  }
  const baseGap = Math.max(GAP_X + 1, maxLabel + 3);
  const centers = assignPositions(byRank, sizes.layH, 1, graph.edges, ranks);

  const edgeBus = Array(graph.edges.length).fill(0) as number[];
  const busTracks = Array(maxRank + 1).fill(0) as number[];
  for (let r = 0; r < maxRank; r++) {
    const spans = busSpansTd(graph, ranks, centers, r, true);
    if (spans.length === 0) continue;
    const { assigned, count } = assignTracks(spans);
    for (const [idx, slot] of assigned) edgeBus[idx] = slot;
    busTracks[r] = count;
  }

  const rankX = Array(maxRank + 1).fill(0) as number[];
  for (let r = 1; r <= maxRank; r++) {
    const gap = Math.max(baseGap, busTracks[r - 1]! + 1);
    rankX[r] = rankX[r - 1]! + colW[r - 1]! + gap;
  }
  let selfExtra = 0;
  for (const i of byRank[maxRank] ?? []) {
    if (sizes.extraH[i]! > 0 && sizes.selfLabelW[i]! > 0) {
      selfExtra = Math.max(selfExtra, 2 + sizes.selfLabelW[i]!);
    }
  }
  const canvasW = rankX[maxRank]! + colW[maxRank]! + selfExtra;
  const bandEnd = Array.from({ length: maxRank + 1 }, (_, r) => rankX[r]! + colW[r]!);

  let diagramH = 1;
  byRank.forEach((row, r) => {
    const x = rankX[r]!;
    for (const idx of row) {
      const w = sizes.boxW[idx]!;
      const h = sizes.boxH[idx]!;
      const cy = centers[idx]!;
      const y = Math.max(0, cy - Math.floor((h + sizes.extraH[idx]!) / 2));
      placed[idx] = { x, y, w, h, cx: x + Math.floor(w / 2), cy: y + Math.floor(h / 2), rank: r };
      diagramH = Math.max(diagramH, y + h + sizes.extraH[idx]!);
    }
  });

  const edgeLane = Array(graph.edges.length).fill(0) as number[];
  const lanes = laneSpans(graph, ranks, placed, false);
  let canvasH: number;
  let laneBase: number;
  if (lanes.length === 0) {
    canvasH = diagramH;
    laneBase = 0;
  } else {
    const { assigned, count } = assignTracks(lanes);
    for (const [idx, slot] of assigned) edgeLane[idx] = slot;
    canvasH = diagramH + 1 + count;
    laneBase = diagramH + 1;
  }
  return { canvas: [canvasW, canvasH], bandEnd, edgeBus, laneBase, edgeLane };
}

function assignTracks(
  spans: Array<[number, number, number, number, number]>,
): { assigned: Array<[number, number]>; count: number } {
  const sorted = spans.slice().sort((a, b) => {
    for (let i = 0; i < 5; i++) if (a[i]! !== b[i]!) return a[i]! - b[i]!;
    return 0;
  });
  const tracks: Array<Array<[number, number, number, number]>> = [];
  const out: Array<[number, number]> = [];
  for (const [s, e, f, t, idx] of sorted) {
    let slot = tracks.findIndex((members) =>
      members.every(([s2, e2, f2, t2]) => e2 + 2 <= s || e + 2 <= s2 || f2 === f || t2 === t),
    );
    if (slot < 0) {
      tracks.push([]);
      slot = tracks.length - 1;
    }
    tracks[slot]!.push([s, e, f, t]);
    out.push([idx, slot]);
  }
  return { assigned: out, count: tracks.length };
}

function orderRanks(byRank: number[][], edges: Edge[], ranks: number[]): void {
  const n = ranks.length;
  if (byRank.length < 2 || n < 3) return;
  const parents: number[][] = Array.from({ length: n }, () => []);
  const children: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    if (e.from !== e.to && ranks[e.to]! > ranks[e.from]!) {
      parents[e.to]!.push(e.from);
      children[e.from]!.push(e.to);
    }
  }
  const pos = Array(n).fill(0) as number[];
  const setPos = () => {
    for (const row of byRank) row.forEach((v, i) => (pos[v] = i));
  };
  setPos();
  let best = byRank.map((r) => r.slice());
  let bestCrossings = countCrossings(edges, ranks, pos);
  if (bestCrossings === 0) return;

  for (let it = 0; it < 8; it++) {
    if (it % 2 === 0) {
      for (let ri = 1; ri < byRank.length; ri++) {
        sortByBarycenter(byRank[ri]!, parents, pos);
        byRank[ri]!.forEach((v, i) => (pos[v] = i));
      }
    } else {
      for (let ri = byRank.length - 2; ri >= 0; ri--) {
        sortByBarycenter(byRank[ri]!, children, pos);
        byRank[ri]!.forEach((v, i) => (pos[v] = i));
      }
    }
    const crossings = countCrossings(edges, ranks, pos);
    if (crossings < bestCrossings) {
      bestCrossings = crossings;
      best = byRank.map((r) => r.slice());
    }
    if (bestCrossings === 0) break;
  }
  for (let i = 0; i < byRank.length; i++) byRank[i] = best[i]!;
}

function sortByBarycenter(row: number[], neigh: number[][], pos: number[]): void {
  const keyed = row.map((v) => {
    const ns = neigh[v]!;
    const key = ns.length === 0 ? pos[v]! : ns.reduce((a, u) => a + pos[u]!, 0) / ns.length;
    return { key, v };
  });
  keyed.sort((a, b) => a.key - b.key || 0);
  keyed.forEach((k, i) => (row[i] = k.v));
}

function countCrossings(edges: Edge[], ranks: number[], pos: number[]): number {
  const adjacent: Array<[number, number, number]> = [];
  for (const e of edges) {
    if (e.from !== e.to && ranks[e.to] === ranks[e.from]! + 1) {
      adjacent.push([ranks[e.from]!, pos[e.from]!, pos[e.to]!]);
    }
  }
  let crossings = 0;
  for (let i = 0; i < adjacent.length; i++) {
    const a = adjacent[i]!;
    for (let j = i + 1; j < adjacent.length; j++) {
      const b = adjacent[j]!;
      if (a[0] === b[0] && ((a[1] < b[1] && a[2] > b[2]) || (a[1] > b[1] && a[2] < b[2]))) crossings++;
    }
  }
  return crossings;
}

function assignPositions(
  byRank: number[][],
  size: number[],
  sep: number,
  edges: Edge[],
  ranks: number[],
): number[] {
  const n = size.length;
  const parents: number[][] = Array.from({ length: n }, () => []);
  const children: number[][] = Array.from({ length: n }, () => []);
  for (const e of edges) {
    if (e.from !== e.to && ranks[e.to]! > ranks[e.from]!) {
      parents[e.to]!.push(e.from);
      children[e.from]!.push(e.to);
    }
  }
  const pos = Array(n).fill(0) as number[];
  for (const row of byRank) {
    let x = 0;
    for (const v of row) {
      const half = size[v]! / 2;
      x += half;
      pos[v] = x;
      x += half + sep;
    }
  }
  for (let it = 0; it < 10; it++) {
    if (it % 2 === 0) for (const row of byRank) relaxRank(row, parents, pos, size, sep);
    else for (let ri = byRank.length - 1; ri >= 0; ri--) relaxRank(byRank[ri]!, children, pos, size, sep);
  }
  let minLeft = Infinity;
  for (let v = 0; v < n; v++) minLeft = Math.min(minLeft, pos[v]! - size[v]! / 2);
  if (!Number.isFinite(minLeft)) minLeft = 0;
  return Array.from({ length: n }, (_, v) => Math.max(0, Math.round(pos[v]! - minLeft)));
}

function relaxRank(nodes: number[], neigh: number[][], pos: number[], size: number[], sep: number): void {
  const n = nodes.length;
  if (n === 0) return;
  const desired = nodes.map((v) => {
    const ns = neigh[v]!;
    return ns.length === 0 ? pos[v]! : ns.reduce((a, u) => a + pos[u]!, 0) / ns.length;
  });
  const half = (i: number) => size[nodes[i]!]! / 2;
  const left = Array(n).fill(0) as number[];
  const right = Array(n).fill(0) as number[];
  for (let i = 0; i < n; i++) {
    left[i] = i === 0 ? desired[i]! : Math.max(desired[i]!, left[i - 1]! + half(i - 1) + sep + half(i));
  }
  for (let i = n - 1; i >= 0; i--) {
    right[i] = i === n - 1 ? desired[i]! : Math.min(desired[i]!, right[i + 1]! - half(i + 1) - sep - half(i));
  }
  for (let i = 0; i < n; i++) pos[nodes[i]!] = (left[i]! + right[i]!) / 2;
  for (let i = 1; i < n; i++) {
    const minP = pos[nodes[i - 1]!]! + half(i - 1) + sep + half(i);
    if (pos[nodes[i]!]! < minP) pos[nodes[i]!] = minP;
  }
}

function wrapLabel(label: string, width: number, maxLines: number): string[] {
  width = Math.max(1, width);
  const charW = (c: string) => Math.max(1, charWidth(c));
  const lines: string[] = [];
  let cur = "";
  let curW = 0;
  for (const word of label.split(/\s+/).filter(Boolean)) {
    const ww = displayWidth(word);
    if (ww > width) {
      if (cur) {
        lines.push(cur);
        cur = "";
      }
      let chunk = "";
      let chunkW = 0;
      for (const ch of word) {
        const cw = charW(ch);
        if (chunkW + cw > width && chunk) {
          let carry = "";
          let breakAt = -1;
          for (let p = chunk.length - 1; p >= 0; p--) {
            if (LABEL_BREAK_CHARS.has(chunk[p]!)) {
              breakAt = p;
              break;
            }
          }
          if (breakAt >= 0) {
            carry = chunk.slice(breakAt + 1);
            chunk = chunk.slice(0, breakAt + 1);
          }
          lines.push(chunk);
          chunk = carry;
          chunkW = [...carry].reduce((a, c) => a + charW(c), 0);
        }
        chunk += ch;
        chunkW += cw;
      }
      cur = chunk;
      curW = chunkW;
    } else if (!cur) {
      cur = word;
      curW = ww;
    } else if (curW + 1 + ww <= width) {
      cur += " " + word;
      curW += 1 + ww;
    } else {
      lines.push(cur);
      cur = word;
      curW = ww;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length === 0) lines.push("");
  if (lines.length > maxLines) {
    lines.length = maxLines;
    const last = lines[maxLines - 1]!;
    const target = Math.max(1, width - 1);
    let s = "";
    let sw = 0;
    for (const ch of last) {
      const cw = charW(ch);
      if (sw + cw > target) break;
      s += ch;
      sw += cw;
    }
    lines[maxLines - 1] = s + "…";
  }
  return lines;
}

function fitLabel(label: string, inner: number): string {
  if (displayWidth(label) <= inner) return label;
  let out = "";
  let used = 0;
  for (const c of label) {
    const cw = charWidth(c);
    if (used + cw + 1 > inner) break;
    out += c;
    used += cw;
  }
  return out + "…";
}

function drawBox(canvas: Canvas, p: Placed, lines: string[], shape: Shape): void {
  const { x, y, w, h } = p;
  const right = x + w - 1;
  const bottom = y + h - 1;
  const [tl, tr, bl, br] =
    shape === "round" || shape === "diamond"
      ? (["╭", "╮", "╰", "╯"] as const)
      : (["┌", "┐", "└", "┘"] as const);
  canvas.set(x, y, tl, "border");
  canvas.set(right, y, tr, "border");
  canvas.set(x, bottom, bl, "border");
  canvas.set(right, bottom, br, "border");
  for (let cx = x + 1; cx < right; cx++) {
    canvas.addBits(cx, y, L | R);
    canvas.addBits(cx, bottom, L | R);
  }
  for (let cy = y + 1; cy < bottom; cy++) {
    canvas.addBits(x, cy, U | D);
    canvas.addBits(right, cy, U | D);
  }
  for (let cy = y; cy <= bottom; cy++) {
    for (let cx = x; cx <= right; cx++) canvas.occupied[canvas.idx(cx, cy)] = true;
  }
  const inner = Math.max(1, w - 2 * PAD - 2);
  lines.forEach((line, li) => {
    const row = y + 1 + li;
    const text = fitLabel(line, inner);
    const tw = displayWidth(text);
    let cur = x + 1 + PAD + Math.floor((inner - tw) / 2);
    for (const c of text) {
      const cw = Math.max(1, charWidth(c));
      canvas.set(cur, row, c, "text");
      for (let k = 1; k < cw; k++) canvas.set(cur + k, row, CONT, "text");
      cur += cw;
    }
  });
}

function routeForward(canvas: Canvas, from: Placed, to: Placed, edge: Edge, bus: number): void {
  const tx = to.cx;
  const bx = Math.abs(from.cx - tx) <= 1 ? tx : from.cx;
  const by = from.y + from.h - 1;
  const headRow = to.y - 1;
  canvas.junction(bx, by, D);
  canvas.segV(bx, by, bus);
  if (bx === tx) canvas.segV(bx, bus, headRow);
  else {
    canvas.segH(bus, bx, tx);
    canvas.segV(tx, bus, headRow);
  }
  if (edge.headTo === "none") canvas.addBits(tx, headRow, U);
  else canvas.set(tx, headRow, headGlyph(edge.headTo, "▼"), "edge");
  if (edge.headFrom !== "none") canvas.set(bx, by, headGlyph(edge.headFrom, "▲"), "edge");
  if (edge.label) placeLabel(canvas, edge.label, headRow, tx + 1);
}

function headGlyph(head: Head, arrow: string): string {
  switch (head) {
    case "circle": return "o";
    case "cross": return "×";
    case "diamondFill": return "◆";
    case "diamondOpen": return "◇";
    case "triangle":
      if (arrow === "▼") return "▽";
      if (arrow === "▲") return "△";
      if (arrow === "◄") return "◁";
      if (arrow === "▶") return "▷";
      return arrow;
    default: return arrow;
  }
}

function routeSelf(canvas: Canvas, p: Placed, edge: Edge): void {
  const bottom = p.y + p.h - 1;
  const exitX = p.cx + 1;
  const retX = p.x + p.w - 2;
  if (retX <= exitX || bottom + 2 >= canvas.h) return;
  let v: string, h: string, bl: string, br: string;
  if (edge.line === "dotted") [v, h, bl, br] = ["╎", "╌", "╰", "╯"];
  else if (edge.line === "thick") [v, h, bl, br] = ["┃", "━", "┗", "┛"];
  else [v, h, bl, br] = ["│", "─", "╰", "╯"];
  canvas.junction(exitX, bottom, D);
  canvas.set(exitX, bottom + 1, v, "edge");
  canvas.set(exitX, bottom + 2, bl, "edge");
  for (let x = exitX + 1; x < retX; x++) canvas.set(x, bottom + 2, h, "edge");
  canvas.set(retX, bottom + 2, br, "edge");
  canvas.set(retX, bottom + 1, headGlyph(edge.headTo, "▲"), "edge");
  if (edge.label) placeLabel(canvas, edge.label, bottom + 1, p.x + p.w + 1);
}

function routeBack(canvas: Canvas, from: Placed, to: Placed, edge: Edge, laneX: number): void {
  const sx = from.x + from.w - 1;
  const sy = from.cy;
  const tx = to.x + to.w - 1;
  const tyc = to.cy;
  canvas.junction(sx, sy, R);
  canvas.segH(sy, sx, laneX);
  canvas.segV(laneX, sy, tyc);
  canvas.segH(tyc, tx + 1, laneX);
  if (edge.headTo === "none") canvas.addBits(tx + 1, tyc, R);
  else canvas.set(tx + 1, tyc, headGlyph(edge.headTo, "◄"), "edge");
  if (edge.headFrom !== "none") canvas.set(sx, sy, headGlyph(edge.headFrom, "◄"), "edge");
  if (edge.label) {
    placeLabel(canvas, edge.label, Math.max(0, tyc - 1), Math.max(0, laneX - displayWidth(edge.label) - 1));
  }
}

function routeForwardLr(canvas: Canvas, from: Placed, to: Placed, edge: Edge, bus: number): void {
  const rx = from.x + from.w - 1;
  const ry = from.cy;
  const ly = to.cy;
  const headCol = to.x - 1;
  canvas.junction(rx, ry, R);
  canvas.segH(ry, rx, bus);
  if (ry === ly) canvas.segH(ry, bus, headCol);
  else {
    canvas.segV(bus, ry, ly);
    canvas.segH(ly, bus, headCol);
  }
  if (edge.headTo === "none") canvas.addBits(headCol, ly, R);
  else canvas.set(headCol, ly, headGlyph(edge.headTo, "▶"), "edge");
  if (edge.headFrom !== "none") canvas.set(rx, ry, headGlyph(edge.headFrom, "◄"), "edge");
  if (edge.label) placeLabel(canvas, edge.label, Math.max(0, ly - 1), bus + 1);
}

function routeBackLr(canvas: Canvas, from: Placed, to: Placed, edge: Edge, laneY: number): void {
  const sx = from.cx;
  const sy = from.y + from.h - 1;
  const tx = to.cx;
  const ty = to.y + to.h - 1;
  canvas.junction(sx, sy, D);
  canvas.segV(sx, sy, laneY);
  canvas.segH(laneY, sx, tx);
  canvas.segV(tx, laneY, ty + 1);
  if (edge.headTo === "none") canvas.addBits(tx, ty + 1, D);
  else canvas.set(tx, ty + 1, headGlyph(edge.headTo, "▲"), "edge");
  if (edge.headFrom !== "none") canvas.set(sx, sy, headGlyph(edge.headFrom, "▲"), "edge");
  if (edge.label) placeLabel(canvas, edge.label, Math.max(0, laneY - 1), Math.floor((sx + tx) / 2));
}

function placeLabel(canvas: Canvas, label: string, row: number, startX: number): void {
  if (row >= canvas.h) return;
  const text = fitLabel(label, MAX_LABEL);
  let x = startX;
  for (const c of text) {
    const cw = Math.max(1, charWidth(c));
    if (x + cw > canvas.w) break;
    let blocked = false;
    for (let k = 0; k < cw; k++) {
      const i = canvas.idx(x + k, row);
      if (canvas.ch[i] !== " " || canvas.mask[i] !== 0 || canvas.occupied[i]) {
        blocked = true;
        break;
      }
    }
    if (blocked) break;
    canvas.set(x, row, c, "edgeLabel");
    for (let k = 1; k < cw; k++) canvas.set(x + k, row, CONT, "edgeLabel");
    x += cw;
  }
}

function computeRanks(graph: Graph): number[] {
  const n = graph.nodes.length;
  const children: number[][] = Array.from({ length: n }, () => []);
  const indeg = Array(n).fill(0) as number[];
  for (const e of graph.edges) {
    if (e.from !== e.to) {
      children[e.from]!.push(e.to);
      indeg[e.to]!++;
    }
  }
  const color = Array(n).fill(0) as number[];
  const dag: number[][] = Array.from({ length: n }, () => []);
  const order: number[] = [];
  const roots = Array.from({ length: n }, (_, i) => i).filter((i) => indeg[i] === 0);
  for (const start of [...roots, ...Array.from({ length: n }, (_, i) => i)]) {
    if (color[start] === 0) dfsDag(start, children, color, dag, order);
  }
  const rank = Array(n).fill(0) as number[];
  for (let i = order.length - 1; i >= 0; i--) {
    const u = order[i]!;
    for (const v of dag[u]!) rank[v] = Math.max(rank[v]!, rank[u]! + 1);
  }
  return rank;
}

function dfsDag(
  start: number,
  children: number[][],
  color: number[],
  dag: number[][],
  order: number[],
): void {
  const stack: Array<[number, number]> = [[start, 0]];
  color[start] = 1;
  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    const u = frame[0];
    if (frame[1] < children[u]!.length) {
      const v = children[u]![frame[1]!]!;
      frame[1]++;
      if (color[v] === 1) continue;
      dag[u]!.push(v);
      if (color[v] === 0) {
        color[v] = 1;
        stack.push([v, 0]);
      }
    } else {
      color[u] = 2;
      order.push(u);
      stack.pop();
    }
  }
}


type SeqHead = "arrow" | "cross";
type NoteAnchor =
  | { kind: "over"; a: number; b: number }
  | { kind: "left"; i: number }
  | { kind: "right"; i: number };

type SeqItem =
  | { kind: "message"; from: number; to: number; text: string | null; dashed: boolean; head: SeqHead }
  | { kind: "note"; anchor: NoteAnchor; text: string }
  | { kind: "divider"; text: string };

const SEQ_OPS: Array<[string, boolean, SeqHead]> = [
  ["-->>", true, "arrow"],
  ["->>", false, "arrow"],
  ["--x", true, "cross"],
  ["-x", false, "cross"],
  ["--)", true, "arrow"],
  ["-)", false, "arrow"],
  ["-->", true, "arrow"],
  ["->", false, "arrow"],
];

class Sequence {
  labels: string[] = [];
  index = new Map<string, number>();
  items: SeqItem[] = [];

  participant(id: string, label: string | null): number | null {
    const existing = this.index.get(id);
    if (existing !== undefined) {
      if (label !== null) this.labels[existing] = label;
      return existing;
    }
    if (this.labels.length >= MAX_NODES) return null;
    const i = this.labels.length;
    this.index.set(id, i);
    this.labels.push(label ?? id);
    return i;
  }
}

function parseSequence(src: string): Sequence | null {
  const statements: string[] = [];
  for (const raw of src.split(/\r?\n/)) splitStatements(raw, statements);
  if (statements.length === 0) return null;
  const firstTok = statements[0]!.split(/\s+/).filter(Boolean)[0] ?? "";
  if (firstTok.toLowerCase() !== "sequencediagram") return null;

  const seq = new Sequence();
  let autonumber = false;
  let msgCount = 0;
  const blocks: boolean[] = [];

  for (const st of statements.slice(1)) {
    const first = (st.split(/\s+/).filter(Boolean)[0] ?? "").toLowerCase();
    if (first === "participant" || first === "actor") {
      const rest = st.slice(first.length).trim();
      if (!rest) return null;
      let id = rest;
      let label: string | null = null;
      const asSplit = rest.split(" as ");
      if (asSplit.length >= 2) {
        id = asSplit[0]!.trim();
        label = cleanLabel(asSplit.slice(1).join(" as "));
      }
      if (seq.participant(id, label) === null) return null;
    } else if (first === "autonumber") {
      autonumber = true;
    } else if (
      first === "activate" || first === "deactivate" || first === "create" || first === "destroy" ||
      first === "title" || first === "acctitle" || first === "accdescr" || first === "links" ||
      first === "link" || first === "properties"
    ) {
      // ignore
    } else if (first === "note") {
      const rest = st.slice(first.length).trim();
      const note = parseNoteAnchor(rest, seq);
      if (!note) return null;
      if (seq.items.length >= MAX_EDGES) return null;
      seq.items.push({ kind: "note", anchor: note.anchor, text: note.text });
    } else if (
      first === "loop" || first === "alt" || first === "opt" || first === "par" ||
      first === "critical" || first === "break" || first === "else" || first === "and" || first === "option"
    ) {
      if (first === "else" || first === "and" || first === "option") {
        if (blocks[blocks.length - 1] !== true) continue;
      } else blocks.push(true);
      if (seq.items.length >= MAX_EDGES) return null;
      seq.items.push({ kind: "divider", text: decodeHtmlEntities(st) });
    } else if (first === "rect" || first === "box") {
      blocks.push(false);
    } else if (first === "end") {
      if (blocks.pop() === true) {
        if (seq.items.length >= MAX_EDGES) return null;
        seq.items.push({ kind: "divider", text: "end" });
      }
    } else {
      const msg = parseSeqMessage(st, seq);
      if (!msg) return null;
      let text = msg.text;
      if (autonumber) {
        msgCount++;
        text = text !== null ? `${msgCount}. ${text}` : `${msgCount}.`;
      }
      if (seq.items.length >= MAX_EDGES) return null;
      seq.items.push({
        kind: "message", from: msg.from, to: msg.to, text, dashed: msg.dashed, head: msg.head,
      });
    }
  }
  if (seq.labels.length === 0) return null;
  return seq;
}

function parseNoteAnchor(rest: string, seq: Sequence): { text: string; anchor: NoteAnchor } | null {
  const lower = rest.toLowerCase();
  let kind = 0;
  let idsAndText = "";
  if (lower.startsWith("over ")) {
    idsAndText = rest.slice("over ".length);
    kind = 0;
  } else if (lower.startsWith("left of ")) {
    idsAndText = rest.slice("left of ".length);
    kind = 1;
  } else if (lower.startsWith("right of ")) {
    idsAndText = rest.slice("right of ".length);
    kind = 2;
  } else return null;
  const colon = idsAndText.indexOf(":");
  if (colon < 0) return null;
  const ids = idsAndText.slice(0, colon);
  const text = decodeHtmlEntities(idsAndText.slice(colon + 1).trim());
  const parts = ids.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const a = seq.participant(parts[0]!, null);
  if (a === null) return null;
  let anchor: NoteAnchor;
  if (kind === 0) {
    let b = a;
    if (parts[1]) {
      const bi = seq.participant(parts[1], null);
      if (bi === null) return null;
      b = bi;
    }
    anchor = { kind: "over", a: Math.min(a, b), b: Math.max(a, b) };
  } else if (kind === 1) anchor = { kind: "left", i: a };
  else anchor = { kind: "right", i: a };
  return { text, anchor };
}

function parseSeqMessage(
  st: string,
  seq: Sequence,
): { from: number; to: number; text: string | null; dashed: boolean; head: SeqHead } | null {
  let found: { pos: number; op: string; dashed: boolean; head: SeqHead } | null = null;
  for (let pos = 0; pos < st.length; ) {
    for (const [op, dashed, head] of SEQ_OPS) {
      if (st.startsWith(op, pos)) {
        found = { pos, op, dashed, head };
        break;
      }
    }
    if (found) break;
    pos += (st.codePointAt(pos)! > 0xffff ? 2 : 1);
  }
  if (!found) return null;
  const fromId = st.slice(0, found.pos).trim();
  if (!fromId) return null;
  let rest = st.slice(found.pos + found.op.length).trimStart();
  while (rest.startsWith("+") || rest.startsWith("-")) rest = rest.slice(1);
  let toId = rest;
  let text: string | null = null;
  const colon = rest.indexOf(":");
  if (colon >= 0) {
    toId = rest.slice(0, colon).trim();
    text = nonEmpty(decodeHtmlEntities(rest.slice(colon + 1).trim()));
  } else toId = rest.trim();
  if (!toId) return null;
  const from = seq.participant(fromId, null);
  if (from === null) return null;
  const to = seq.participant(toId, null);
  if (to === null) return null;
  return { from, to, text, dashed: found.dashed, head: found.head };
}

function noteGeometry(xs: number[], anchor: NoteAnchor, textW: number): [number, number] {
  if (anchor.kind === "over") {
    const center = Math.floor((xs[anchor.a]! + xs[anchor.b]!) / 2);
    const w = Math.max(xs[anchor.b]! - xs[anchor.a]! + 5, textW + 2 * PAD + 2);
    return [Math.max(0, center - Math.floor(w / 2)), w];
  }
  if (anchor.kind === "left") {
    const w = textW + 2 * PAD + 2;
    return [Math.max(0, xs[anchor.i]! - (2 + w - 1)), w];
  }
  return [xs[anchor.i]! + 2, textW + 2 * PAD + 2];
}

function layoutSequence(seq: Sequence, styles: MermaidStyles, maxWidth: number | undefined): string[] {
  const n = seq.labels.length;
  const labels = seq.labels.map((l) => fitLabel(l, WRAP_WIDTH));
  const boxW = labels.map((l) => Math.max(1, displayWidth(l)) + 2 * PAD + 2);
  const boxH = 3;
  const itemTextW = (text: string | null) => (text ? displayWidth(text) : 0);

  const gaps = Array.from({ length: Math.max(0, n - 1) }, (_, i) =>
    Math.max(SEQ_GAP, Math.ceil(boxW[i]! / 2) + Math.ceil(boxW[i + 1]! / 2) + 1),
  );

  const reqs: Array<[number, number, number]> = [];
  for (const item of seq.items) {
    if (item.kind === "message") {
      const tw = itemTextW(item.text);
      if (item.from !== item.to) {
        const l = Math.min(item.from, item.to);
        const r = Math.max(item.from, item.to);
        reqs.push([l, r, Math.max(tw + 2, 4)]);
      } else if (item.from + 1 < n) {
        reqs.push([item.from, item.from + 1, 5 + tw + 2]);
      }
    } else if (item.kind === "note") {
      const tw = displayWidth(item.text);
      const a = item.anchor;
      if (a.kind === "over" && a.a < a.b) reqs.push([a.a, a.b, Math.max(0, tw - 1)]);
      else if (a.kind === "over") {
        const half = Math.ceil((tw + 4) / 2) + 2;
        if (a.a > 0) reqs.push([a.a - 1, a.a, half]);
        if (a.a + 1 < n) reqs.push([a.a, a.a + 1, half]);
      } else if (a.kind === "left" && a.i > 0) reqs.push([a.i - 1, a.i, tw + 7]);
      else if (a.kind === "right" && a.i + 1 < n) reqs.push([a.i, a.i + 1, tw + 7]);
    }
  }
  reqs.sort((a, b) => a[1] - a[0] - (b[1] - b[0]));
  for (const [l, r, need] of reqs) {
    let cur = 0;
    for (let i = l; i < r; i++) cur += gaps[i]!;
    if (cur < need) gaps[r - 1]! += need - cur;
  }

  const xs = Array(n).fill(0) as number[];
  xs[0] = Math.floor(boxW[0]! / 2);
  for (let i = 1; i < n; i++) xs[i] = xs[i - 1]! + gaps[i - 1]!;

  let canvasW = xs[n - 1]! + Math.ceil(boxW[n - 1]! / 2) + 1;
  for (const item of seq.items) {
    if (item.kind === "message" && item.from === item.to) {
      canvasW = Math.max(canvasW, xs[item.from]! + 5 + itemTextW(item.text) + 1);
    } else if (item.kind === "note") {
      const [x, w] = noteGeometry(xs, item.anchor, displayWidth(item.text));
      canvasW = Math.max(canvasW, x + w + 1);
    } else if (item.kind === "divider") {
      canvasW = Math.max(canvasW, displayWidth(item.text) + 4);
    }
  }

  const rows: number[] = [];
  let y = boxH + 1;
  for (const item of seq.items) {
    rows.push(y);
    if (item.kind === "message") {
      if (item.from === item.to) y += 4;
      else if (item.text !== null) y += 3;
      else y += 2;
    } else if (item.kind === "note") y += 4;
    else y += 2;
  }
  const bottomTop = y;
  const canvasH = bottomTop + boxH;

  if (maxWidth !== undefined && canvasW > maxWidth) throw new OversizeError("width");
  if (canvasW * canvasH > MAX_CANVAS_CELLS) throw new OversizeError("cells");

  const canvas = new Canvas(canvasW, canvasH);
  for (let i = 0; i < n; i++) {
    for (const by of [0, bottomTop]) {
      const p: Placed = {
        x: Math.max(0, xs[i]! - Math.floor(boxW[i]! / 2)),
        y: by,
        w: boxW[i]!,
        h: boxH,
        cx: xs[i]!,
        cy: by + 1,
        rank: 0,
      };
      drawBox(canvas, p, [labels[i]!], "rect");
    }
  }
  seq.items.forEach((item, ii) => {
    if (item.kind === "note") {
      const r = rows[ii]!;
      const [x, w] = noteGeometry(xs, item.anchor, displayWidth(item.text));
      const p: Placed = { x, y: r, w, h: 3, cx: x + Math.floor(w / 2), cy: r + 1, rank: 0 };
      drawBox(canvas, p, [item.text], "rect");
    }
  });
  for (const x of xs) {
    canvas.junction(x, boxH - 1, D);
    canvas.segV(x, boxH, bottomTop - 1);
    canvas.junction(x, bottomTop, U);
  }

  seq.items.forEach((item, ii) => {
    const r = rows[ii]!;
    if (item.kind === "message") {
      const lineCh = item.dashed ? "╌" : "─";
      if (item.from === item.to) {
        const x = xs[item.from]!;
        canvas.junction(x, r, R);
        canvas.set(x + 1, r, lineCh, "edge");
        canvas.set(x + 2, r, lineCh, "edge");
        canvas.set(x + 3, r, "╮", "edge");
        canvas.set(x + 3, r + 1, "│", "edge");
        canvas.set(x + 1, r + 2, item.head === "cross" ? "×" : "◄", "edge");
        canvas.set(x + 2, r + 2, lineCh, "edge");
        canvas.set(x + 3, r + 2, "╯", "edge");
        if (item.text) drawSeqText(canvas, item.text, x + 5, r + 1, "text");
      } else {
        const x0 = xs[item.from]!;
        const x1 = xs[item.to]!;
        const rightward = x1 > x0;
        const arrowRow = item.text !== null ? r + 1 : r;
        const lo = Math.min(x0, x1);
        const hi = Math.max(x0, x1);
        canvas.junction(x0, arrowRow, rightward ? R : L);
        for (let x = lo + 1; x < hi; x++) canvas.set(x, arrowRow, lineCh, "edge");
        const headCh = item.head === "cross" ? "×" : rightward ? "▶" : "◄";
        const headX = rightward ? x1 - 1 : x1 + 1;
        canvas.set(headX, arrowRow, headCh, "edge");
        if (item.text) {
          const span = hi - lo - 1;
          const t = fitLabel(item.text, Math.max(1, span));
          const tx = lo + 1 + Math.floor((span - displayWidth(t)) / 2);
          drawSeqText(canvas, t, tx, r, "text");
        }
      }
    } else if (item.kind === "divider") {
      for (let x = 0; x < canvasW; x++) canvas.set(x, r, "─", "edge");
      const t = fitLabel(item.text, Math.max(0, canvasW - 4));
      drawSeqText(canvas, ` ${t} `, 2, r, "edgeLabel");
    }
  });

  canvas.finalizeMask();
  return canvas.toLines(styles);
}

function drawSeqText(canvas: Canvas, text: string, x: number, y: number, cls: Cls): void {
  let cur = x;
  for (const c of text) {
    const cw = Math.max(1, charWidth(c));
    for (let k = 0; k < cw; k++) {
      if (cur + k < canvas.w && y < canvas.h) {
        canvas.mask[canvas.idx(cur + k, y)] = 0;
      }
      canvas.set(cur + k, y, k === 0 ? c : CONT, cls);
    }
    cur += cw;
  }
}

const TOO_WIDE_HINT =
  "This diagram is too wide to display here \u2014 open the image to view it in full.";

function fallback(
  src: string,
  styles: MermaidStyles,
  maxWidth: number | undefined,
  tooWide: boolean,
): string[] {
  const header = firstWord(src);
  const title = ` mermaid: ${header} `;
  const limit = maxWidth !== undefined ? Math.max(8, maxWidth - 4) : undefined;
  const body: string[] = [];
  let started = false;
  for (const l of src.split(/\r?\n/)) {
    const line = l.replace(/[ \t]+$/, "");
    if (!started && line === "") continue;
    started = true;
    body.push(...chunkLine(line, limit));
  }
  let contentW = displayWidth(title);
  for (const l of body) contentW = Math.max(contentW, displayWidth(l));
  const inner = contentW + 2;
  const lines: string[] = [];

  const padTitle = Math.max(0, inner - displayWidth(title));
  lines.push(styles.border("╭") + styles.title(title) + styles.border("─".repeat(padTitle) + "╮"));
  for (const line of body) {
    const pad = Math.max(0, contentW - displayWidth(line));
    lines.push(styles.border("│ ") + styles.nodeText(line) + styles.border(" ".repeat(pad) + " │"));
  }
  lines.push(styles.border("╰" + "─".repeat(inner) + "╯"));
  if (tooWide) {
    for (const chunk of wrapWords(TOO_WIDE_HINT, maxWidth)) lines.push(styles.border(chunk));
  }
  return lines;
}

function chunkLine(line: string, limit: number | undefined): string[] {
  if (limit === undefined) return [line];
  if (displayWidth(line) <= limit) return [line];
  const out: string[] = [];
  let cur = "";
  let curW = 0;
  for (const c of line) {
    const cw = Math.max(1, charWidth(c));
    if (curW + cw > limit && cur) {
      out.push(cur);
      cur = "";
      curW = 0;
    }
    cur += c;
    curW += cw;
  }
  if (cur) out.push(cur);
  return out;
}

function wrapWords(text: string, limit: number | undefined): string[] {
  if (limit === undefined) return [text];
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(" ").filter(Boolean)) {
    if (!cur) cur = word;
    else if (displayWidth(cur) + 1 + displayWidth(word) <= limit) cur += " " + word;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines.flatMap((l) => chunkLine(l, limit));
}

function firstWord(src: string): string {
  return src.split(/\s+/).filter(Boolean)[0] ?? "diagram";
}
