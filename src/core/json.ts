export function parseJsoncObject(text: string): Record<string, unknown> {
  return assertJsonObject(Bun.JSON5.parse(text));
}

function assertJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected JSON object");
  }
  return value as Record<string, unknown>;
}
