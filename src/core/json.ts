export function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected JSON object");
  }
  return value as Record<string, unknown>;
}

export function stringifyJson(value: unknown, pretty = false): string {
  return JSON.stringify(value, null, pretty ? 2 : 0);
}
