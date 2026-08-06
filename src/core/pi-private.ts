/**
 * Load private (unexported) helpers from @earendil-works/pi-coding-agent dist.
 * package.json only exports `.` and `./rpc-entry`, so subpath imports fail —
 * resolve via the package entry like mpi-mid-turn-compact does for prepareCompaction.
 */
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type ClipboardImage = {
  bytes: Uint8Array;
  mimeType: string;
};

type ClipboardImageModule = {
  readClipboardImage?: (options?: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  }) => Promise<ClipboardImage | null>;
  extensionForImageMimeType?: (mimeType: string) => string | null;
};

type ClipboardModule = {
  readClipboardText?: () => Promise<string | null>;
};

let distDirLoader: Promise<string | null> | undefined;
let clipboardImageLoader: Promise<ClipboardImageModule | null> | undefined;
let clipboardLoader: Promise<ClipboardModule | null> | undefined;

async function resolvePiCodingAgentDistDir(): Promise<string | null> {
  if (!distDirLoader) {
    distDirLoader = (async () => {
      try {
        return path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
      } catch {
        return null;
      }
    })();
  }
  return distDirLoader;
}

async function importFromDist<T extends object>(relativePath: string): Promise<T | null> {
  const distDir = await resolvePiCodingAgentDistDir();
  if (!distDir) return null;
  try {
    const href = pathToFileURL(path.join(distDir, relativePath)).href;
    return (await import(href)) as T;
  } catch {
    return null;
  }
}

async function loadClipboardImageModule(): Promise<ClipboardImageModule | null> {
  if (!clipboardImageLoader) {
    clipboardImageLoader = importFromDist<ClipboardImageModule>("utils/clipboard-image.js");
  }
  return clipboardImageLoader;
}

async function loadClipboardModule(): Promise<ClipboardModule | null> {
  if (!clipboardLoader) {
    clipboardLoader = importFromDist<ClipboardModule>("utils/clipboard.js");
  }
  return clipboardLoader;
}

/** Read image bytes from the system clipboard, or null when empty/unavailable. */
export async function readClipboardImage(options?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): Promise<ClipboardImage | null> {
  const mod = await loadClipboardImageModule();
  if (typeof mod?.readClipboardImage !== "function") return null;
  return mod.readClipboardImage(options);
}

/** Map image MIME to a file extension, or null when unsupported. */
export async function extensionForImageMimeType(mimeType: string): Promise<string | null> {
  const mod = await loadClipboardImageModule();
  if (typeof mod?.extensionForImageMimeType !== "function") return null;
  return mod.extensionForImageMimeType(mimeType);
}

/** Read plain text from the system clipboard, or null when empty/unavailable. */
export async function readClipboardText(): Promise<string | null> {
  const mod = await loadClipboardModule();
  if (typeof mod?.readClipboardText !== "function") return null;
  return mod.readClipboardText();
}

/**
 * Pi-parity clipboard paste: prefer image (temp path for the editor), else text.
 * Returns null when neither is available (or loaders missing).
 * Optional readers are test seams; production callers omit them.
 */
export async function clipboardPasteForEditor(options?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  tempDir?: string;
  readImage?: typeof readClipboardImage;
  readText?: typeof readClipboardText;
  imageExt?: typeof extensionForImageMimeType;
}): Promise<{ kind: "image"; path: string } | { kind: "text"; text: string } | null> {
  const readImage = options?.readImage ?? readClipboardImage;
  const readText = options?.readText ?? readClipboardText;
  const imageExt = options?.imageExt ?? extensionForImageMimeType;
  const image = await readImage({ env: options?.env, platform: options?.platform });
  if (image) {
    const ext = (await imageExt(image.mimeType)) ?? "png";
    const dir = options?.tempDir ?? (await import("node:os")).tmpdir();
    const filePath = path.join(dir, `mixcode-clipboard-${crypto.randomUUID()}.${ext}`);
    await Bun.write(filePath, image.bytes);
    return { kind: "image", path: filePath };
  }
  const text = await readText();
  if (text) return { kind: "text", text };
  return null;
}

/** Test helper: reset private-module loaders. */
export function resetPiPrivateLoadersForTests(): void {
  distDirLoader = undefined;
  clipboardImageLoader = undefined;
  clipboardLoader = undefined;
}
