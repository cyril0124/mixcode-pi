export interface ForkSelectorState {
  open: boolean;
  sessionId: string;
  items: Array<{ entryId: string; text: string }>;
  selectedIndex: number;
}

export function createForkSelectorState(): ForkSelectorState {
  return { open: false, sessionId: "", items: [], selectedIndex: 0 };
}
