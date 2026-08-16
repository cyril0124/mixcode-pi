export interface EncodeSendKeysOptions {
  literal?: boolean;
}

const NAMED_KEYS: Record<string, string> = {
  enter: "\r",
  return: "\r",
  c_m: "\r",
  escape: "\x1b",
  esc: "\x1b",
  tab: "\t",
  bspace: "\x7f",
  backspace: "\x7f",
  space: " ",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  c_space: "\x00",
};

function normalizeKeyName(token: string): string {
  return token.trim().toLowerCase().replace(/-/g, "_");
}

function encodeCtrl(letter: string): string {
  const ch = letter.toLowerCase();
  if (ch.length !== 1 || ch < "a" || ch > "z") {
    throw new Error(`Unknown send-keys token: C-${letter}`);
  }
  return String.fromCharCode(ch.charCodeAt(0) - 96);
}

/** Encode tmux-style send-keys tokens into stdin-equivalent bytes. */
export function encodeSendKeys(tokens: string[], options: EncodeSendKeysOptions = {}): string {
  if (options.literal) return tokens.join("");
  let out = "";
  for (const token of tokens) {
    if (token.length === 0) continue;
    const named = NAMED_KEYS[normalizeKeyName(token)];
    if (named !== undefined) {
      out += named;
      continue;
    }
    const ctrl = token.match(/^C-(.+)$/i);
    if (ctrl?.[1]) {
      const inner = ctrl[1];
      if (normalizeKeyName(inner) === "space") {
        out += "\x00";
        continue;
      }
      if (inner.length === 1) {
        out += encodeCtrl(inner);
        continue;
      }
      throw new Error(`Unknown send-keys token: ${token}`);
    }
    const meta = token.match(/^M-(.+)$/i);
    if (meta?.[1]) {
      out += `\x1b${encodeSendKeys([meta[1]])}`;
      continue;
    }
    out += token;
  }
  return out;
}
