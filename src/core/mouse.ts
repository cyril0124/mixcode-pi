export interface SgrMouseInput {
  button: number;
  x: number;
  y: number;
  release: boolean;
  wheel?: "up" | "down";
}

export interface MouseHitRegion {
  id: string;
  startX: number;
  endX: number;
}

const SGR_MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([mM])$/;

export function parseSgrMouseInput(data: string): SgrMouseInput | undefined {
  const match = SGR_MOUSE_PATTERN.exec(data);
  if (!match) return undefined;
  const button = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  const release = match[4] === "m";
  return {
    button,
    x,
    y,
    release,
    wheel: parseSgrWheel(button),
  };
}

function parseSgrWheel(button: number): SgrMouseInput["wheel"] {
  if ((button & 64) === 0) return undefined;
  const direction = button & 3;
  if (direction === 0) return "up";
  if (direction === 1) return "down";
  return undefined;
}

export function hitMouseRegion(regions: MouseHitRegion[], x: number): string | undefined {
  return regions.find((region) => x >= region.startX && x <= region.endX)?.id;
}
