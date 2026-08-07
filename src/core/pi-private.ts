import * as os from "node:os";
import * as path from "node:path";
import {
  type ClipboardImage,
  extensionForImageMimeType,
  readClipboardImage,
  readClipboardText,
} from "@earendil-works/pi-coding-agent";

export type { ClipboardImage };
export { extensionForImageMimeType, readClipboardImage, readClipboardText };

/**
 * Pi-parity clipboard paste: prefer image (temp path for the editor), else text.
 * Returns null when neither source has content.
 * Optional readers let callers inject clipboard sources (e.g. custom paste).
 */
export async function clipboardPasteForEditor(options?: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  tempDir?: string;
  readImage?: typeof readClipboardImage;
  readText?: typeof readClipboardText;
  imageExt?: (mimeType: string) => string | null | Promise<string | null>;
}): Promise<{ kind: "image"; path: string } | { kind: "text"; text: string } | null> {
  const readImage = options?.readImage ?? readClipboardImage;
  const readText = options?.readText ?? readClipboardText;
  const imageExt = options?.imageExt ?? extensionForImageMimeType;
  const image = await readImage({ env: options?.env, platform: options?.platform });
  if (image) {
    const ext = (await imageExt(image.mimeType)) ?? "png";
    const dir = options?.tempDir ?? os.tmpdir();
    const filePath = path.join(dir, `mixcode-clipboard-${crypto.randomUUID()}.${ext}`);
    await Bun.write(filePath, image.bytes);
    return { kind: "image", path: filePath };
  }
  const text = await readText();
  if (text) return { kind: "text", text };
  return null;
}
