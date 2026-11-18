import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, machine, release, type as osType } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parse as parseToml } from "./vendor/smol-toml.js";

const PROVIDER_ID = "codex-relay";
const CLIENT_ORIGINATOR = "codex_cli_rs";

// max_context_window advertised for these models by the relay catalog.
const MAX_CONTEXT_WINDOW = 872_000;
const MODEL_IDS = [
  "gpt-6.2-sol",
  "gpt-6.2-astra",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
] as const;

/** pi thinking level -> Codex reasoning effort. */
const THINKING_LEVEL_MAP = {
  off: null,
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const;

type CodexCredentials = { accessToken: string; accountId: string };

type CodexAuthFile = {
  tokens?: { access_token?: string; account_id?: string; id_token?: string };
};

function accountIdFromJwt(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const parts = token.split(".");
  const payloadSegment = parts[1];
  if (parts.length !== 3 || !payloadSegment) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const claim = payload["https://api.openai.com/auth"] as
      | { chatgpt_account_id?: string }
      | undefined;
    return claim?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

function loadCredentials(): CodexCredentials {
  const path = join(homedir(), ".codex", "auth.json");
  if (!existsSync(path)) throw new Error(`no Codex credentials at ${path}`);
  const contents = readFileSync(path, "utf8");
  let file: CodexAuthFile;
  try {
    file = JSON.parse(contents) as CodexAuthFile;
  } catch {
    // JSON diagnostics can contain token values.
    throw new Error(`${path} is not valid JSON`);
  }

  const accessToken = file.tokens?.access_token;
  if (!accessToken) {
    throw new Error(`${path} has no tokens.access_token (log in with the Codex client first)`);
  }
  const accountId = file.tokens?.account_id ?? accountIdFromJwt(file.tokens?.id_token);
  if (!accountId) {
    throw new Error(
      `${path} has no tokens.account_id and its id_token carries no ChatGPT account claim`,
    );
  }
  return { accessToken, accountId };
}

function loadBaseUrl(): string {
  const path = join(homedir(), ".codex", "config.toml");
  const contents = readFileSync(path, "utf8");
  let config: Record<string, unknown>;
  try {
    config = parseToml(contents);
  } catch {
    // TOML diagnostics can contain credential-bearing source lines.
    throw new Error(`${path} is not valid TOML`);
  }

  const value = config.openai_base_url;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must define a top-level openai_base_url string`);
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`openai_base_url in ${path} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`openai_base_url in ${path} must be an absolute HTTPS URL`);
  }
  return url.href.replace(/\/+$/, "");
}

function loadCodexVersion(): string {
  let output: string;
  try {
    output = execFileSync("codex", ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error(
      "could not run codex --version (5s timeout); ensure Codex is available on PATH",
    );
  }
  const version = /^codex(?:-cli)?\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/m.exec(
    output,
  )?.[1];
  if (!version) throw new Error("unrecognized codex --version output");
  return version;
}

function createCodexHeaders(accountId: string): Record<string, string> {
  const version = loadCodexVersion();
  const userAgent = `${CLIENT_ORIGINATOR}/${version} (${osType()} ${release()}; ${machine()})`;
  const sessionId = randomUUID();
  const turnMetadata = {
    installation_id: sessionId,
    session_id: sessionId,
    thread_id: sessionId,
    turn_id: sessionId,
    window_id: `${sessionId}:0`,
    request_kind: "standard",
    thread_source: "codex_cli",
  };
  return {
    originator: CLIENT_ORIGINATOR,
    "User-Agent": userAgent,
    "chatgpt-account-id": accountId,
    "OpenAI-Beta": "responses=experimental",
    session_id: sessionId,
    "thread-id": sessionId,
    thread_id: sessionId,
    "x-codex-window-id": `${sessionId}:0`,
    "x-codex-installation-id": sessionId,
    "x-codex-beta-features": "remote_compaction_v2",
    "x-codex-turn-metadata": JSON.stringify(turnMetadata),
  };
}

export default function codexRelay(pi: ExtensionAPI): void {
  let credentials: CodexCredentials;
  let baseUrl: string;
  let headers: Record<string, string>;
  try {
    credentials = loadCredentials();
    baseUrl = loadBaseUrl();
    headers = createCodexHeaders(credentials.accountId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[codex-relay] skipped: ${message}`);
    return;
  }

  pi.registerProvider(PROVIDER_ID, {
    name: "Codex Relay",
    baseUrl,
    api: "openai-responses",
    apiKey: credentials.accessToken,
    headers,
    models: MODEL_IDS.map((id) => ({
      id,
      name: id,
      reasoning: true,
      input: ["text", "image"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: MAX_CONTEXT_WINDOW,
      maxTokens: 32_768,
      thinkingLevelMap: { ...THINKING_LEVEL_MAP },
    })),
  });
}
