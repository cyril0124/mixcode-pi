import { uuidv7 } from "@earendil-works/pi-agent-core";

export function createSessionId(): string {
  return uuidv7();
}

export const UUIDV7_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
