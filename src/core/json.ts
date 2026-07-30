import stripJsonComments from "strip-json-comments";

export function parseJsonObject(text: string): Record<string, unknown> {
  return assertJsonObject(JSON.parse(text));
}

export function parseJsoncObject(text: string): Record<string, unknown> {
  return parseJsonObject(removeJsoncTrailingCommas(stripJsonComments(text, { whitespace: false })));
}

function assertJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected JSON object");
  }
  return value as Record<string, unknown>;
}

function removeJsoncTrailingCommas(text: string): string {
  // Comments are stripped first; this only removes commas before object/array closers.
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === "," && isJsoncTrailingComma(text, index)) continue;
    result += char;
  }

  return result;
}

function isJsoncTrailingComma(text: string, commaIndex: number): boolean {
  for (let index = commaIndex + 1; index < text.length; index++) {
    const char = text[index];
    if (!isJsonWhitespace(char)) return char === "}" || char === "]";
  }
  return false;
}

function isJsonWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}
