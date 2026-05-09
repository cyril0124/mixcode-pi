export class NullTerminal {
  columns = 120;
  rows = 40;
  kittyProtocolActive = false;
  requestRender?: () => void;
  constructor(columns?: number, rows?: number) {
    if (columns !== undefined) this.columns = columns;
    if (rows !== undefined) this.rows = rows;
  }
  write(_data: string): void {}
  start(_onInput: (data: string) => void, _onResize: () => void): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
}
