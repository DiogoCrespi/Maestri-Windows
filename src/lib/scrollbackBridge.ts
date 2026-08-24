import { invoke } from "@tauri-apps/api/core";

export const MAX_SCROLLBACK_LINES = 1_000;
export const MAX_SCROLLBACK_BYTES = 128 * 1024;
export const SCROLLBACK_LOAD_TIMEOUT_MS = 1_500;

export interface ScrollbackMetadata {
  scrollbackFile: string | null;
  scrollbackLineCount: number;
}

export interface ScrollbackLoadRequest {
  terminalId: string;
  scrollbackFile?: string | null;
  scrollbackLineCount?: number;
  maxLines?: number;
}

export interface ScrollbackLoadResult extends ScrollbackMetadata {
  data: string;
  source: "native" | "web" | "none";
}

interface NativeScrollbackResult {
  data?: unknown;
  text?: unknown;
  scrollbackFile?: unknown;
  scrollback_file?: unknown;
  scrollbackLineCount?: unknown;
  scrollback_line_count?: unknown;
}

interface WebScrollbackRecord {
  version: 1;
  data: string;
  scrollbackFile: string | null;
  scrollbackLineCount: number;
}

const WEB_SCROLLBACK_PREFIX = "maestri-terminal-scrollback:";

function runtimeWindow(): Window | undefined {
  return typeof window === "undefined" ? undefined : window;
}

function isNativeRuntime(): boolean {
  return runtimeWindow()?.__TAURI_INTERNALS__ !== undefined;
}

function storageKey(terminalId: string): string {
  return `${WEB_SCROLLBACK_PREFIX}${terminalId}`;
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeLineCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

export function countScrollbackLines(data: string): number {
  return splitScrollbackLines(data).length;
}

function splitScrollbackLines(data: string): string[] {
  if (!data) return [];
  const lines: string[] = [];
  let lineStart = 0;

  for (let index = 0; index < data.length; index += 1) {
    const character = data[index];
    if (character === "\r") {
      const delimiterLength = data[index + 1] === "\n" ? 2 : 1;
      lines.push(data.slice(lineStart, index + delimiterLength));
      index += delimiterLength - 1;
      lineStart = index + 1;
    } else if (character === "\n") {
      lines.push(data.slice(lineStart, index + 1));
      lineStart = index + 1;
    }
  }

  if (lineStart < data.length) lines.push(data.slice(lineStart));
  return lines;
}

function truncateUtf8FromStart(data: string, maxBytes: number): string {
  if (maxBytes <= 0 || !data) return "";
  const encoder = new TextEncoder();
  if (encoder.encode(data).length <= maxBytes) return data;

  // Array.from keeps each candidate boundary at a complete Unicode code
  // point, so UTF-8 encodings are never cut through a surrogate pair.
  const codePoints = Array.from(data);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (encoder.encode(codePoints.slice(middle).join("")).length <= maxBytes) high = middle;
    else low = middle + 1;
  }

  let start = low;
  // Do not expose the LF half of a CRLF delimiter when the byte boundary
  // falls between the two original delimiter code points. Discarding the
  // complete delimiter keeps the retained suffix semantically valid.
  if (start > 0 && codePoints[start] === "\n" && codePoints[start - 1] === "\r") start += 1;
  return codePoints.slice(start).join("");
}

export function limitScrollback(data: string, maxLines = MAX_SCROLLBACK_LINES, maxBytes = MAX_SCROLLBACK_BYTES): string {
  if (!data || maxLines <= 0 || maxBytes <= 0) return "";
  const lineLimit = Math.floor(maxLines);
  if (lineLimit <= 0) return "";

  const lines = splitScrollbackLines(data);
  const limited = lines.slice(-lineLimit).join("");
  return truncateUtf8FromStart(limited, maxBytes);
}

export function normalizeScrollbackResult(
  raw: NativeScrollbackResult | string | null | undefined,
  request: ScrollbackLoadRequest,
  source: "native" | "web",
): ScrollbackLoadResult {
  const object = typeof raw === "object" && raw !== null ? raw : undefined;
  const rawData = typeof raw === "string" ? raw : object?.data ?? object?.text;
  const data = limitScrollback(safeString(rawData), request.maxLines ?? MAX_SCROLLBACK_LINES);
  const rawFile = object?.scrollbackFile ?? object?.scrollback_file;
  const rawCount = object?.scrollbackLineCount ?? object?.scrollback_line_count;
  const scrollbackFile = typeof rawFile === "string"
    ? rawFile
    : request.scrollbackFile ?? null;

  return {
    data,
    scrollbackFile,
    scrollbackLineCount: safeLineCount(rawCount) ?? countScrollbackLines(data),
    source,
  };
}

function emptyResult(request: ScrollbackLoadRequest, source: "web" | "none"): ScrollbackLoadResult {
  return {
    data: "",
    scrollbackFile: request.scrollbackFile ?? null,
    scrollbackLineCount: safeLineCount(request.scrollbackLineCount) ?? 0,
    source,
  };
}

function readWebRecord(terminalId: string): WebScrollbackRecord | null {
  const localStorage = runtimeWindow()?.localStorage;
  if (!localStorage) return null;
  try {
    const raw = localStorage.getItem(storageKey(terminalId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WebScrollbackRecord>;
    if (parsed.version !== 1 || typeof parsed.data !== "string") return null;
    return {
      version: 1,
      data: limitScrollback(parsed.data),
      scrollbackFile: typeof parsed.scrollbackFile === "string" ? parsed.scrollbackFile : null,
      scrollbackLineCount: safeLineCount(parsed.scrollbackLineCount) ?? countScrollbackLines(parsed.data),
    };
  } catch {
    return null;
  }
}

export function recordWebScrollback(
  terminalId: string,
  data: string,
  metadata: Partial<ScrollbackMetadata> = {},
): void {
  if (isNativeRuntime() || !data) return;
  const localStorage = runtimeWindow()?.localStorage;
  if (!localStorage) return;

  const previous = readWebRecord(terminalId);
  const combined = limitScrollback(`${previous?.data ?? ""}${data}`);
  const record: WebScrollbackRecord = {
    version: 1,
    data: combined,
    scrollbackFile: metadata.scrollbackFile ?? previous?.scrollbackFile ?? null,
    scrollbackLineCount: countScrollbackLines(combined),
  };
  try {
    localStorage.setItem(storageKey(terminalId), JSON.stringify(record));
  } catch {
    // Preview persistence is best-effort and must never stop the PTY.
  }
}

async function loadWebScrollback(request: ScrollbackLoadRequest): Promise<ScrollbackLoadResult> {
  const record = readWebRecord(request.terminalId);
  if (!record) return emptyResult(request, "none");
  return normalizeScrollbackResult(record, request, "web");
}

export async function loadScrollback(request: ScrollbackLoadRequest): Promise<ScrollbackLoadResult> {
  if (!request.terminalId.trim()) return emptyResult(request, "none");
  if (!isNativeRuntime()) return loadWebScrollback(request);

  const maxLines = Math.max(1, Math.min(request.maxLines ?? MAX_SCROLLBACK_LINES, MAX_SCROLLBACK_LINES));
  const nativeLoad = invoke<NativeScrollbackResult>("terminal_load_scrollback", {
    id: request.terminalId,
    maxLines,
  });
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error("scrollback load timed out")), SCROLLBACK_LOAD_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([nativeLoad, timeout]);
    return normalizeScrollbackResult(result, { ...request, maxLines }, "native");
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}
