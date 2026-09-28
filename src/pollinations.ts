/**
 * Pollinations transport + BYOP device flow.
 *
 * Pure TypeScript with zero Figma imports so it can be unit-tested in Node.
 * Uses the global `fetch` (available in Figma's ui iframe and Node >= 18).
 */

export const ENTER = "https://enter.pollinations.ai";
export const GEN = "https://gen.pollinations.ai";

export const CLIENT_ID = "pk_5drKIx9HHnvmdcqW"; // publishable app key

export interface ImageModel {
  name: string;
  title?: string;
  description?: string;
  publisher?: string;
  input_modalities?: string[];
  output_modalities?: string[];
  supported_endpoints?: string[];
  health?: { status?: string; success_rate?: number };
  [key: string]: unknown;
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export type DevicePollState =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "done"; access_token: string };

export class PollinationsError extends Error {
  readonly kind: "network" | "auth" | "payment" | "rate_limit" | "api" | "invalid";
  constructor(kind: PollinationsError["kind"], message: string) {
    super(message);
    this.name = "PollinationsError";
    this.kind = kind;
  }
}

/** Minimal fetch surface we rely on, portable across DOM / Node / Figma typings. */
interface SimpleResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type FetchLike = (url: string, init?: Record<string, unknown>) => Promise<SimpleResponse>;

/** Lazily resolved fetch so test stubs on globalThis are always picked up. */
function httpFetch(): FetchLike {
  const candidate = (globalThis as { fetch?: unknown }).fetch;
  if (typeof candidate !== "function") {
    throw new PollinationsError("network", "fetch is unavailable in this environment.");
  }
  return candidate as FetchLike;
}

/** One JSON request against the Pollinations API. Bearer auth optional. */
export async function requestJson(
  url: string,
  payload?: unknown,
  token?: string,
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  let body: string | undefined;
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(payload);
  }
  if (token) headers["Authorization"] = "Bearer " + token;
  let response: SimpleResponse;
  try {
    response = await httpFetch()(url, { method: "POST", headers, body });
  } catch (error) {
    if (error instanceof PollinationsError) throw error;
    throw new PollinationsError("network", "Connection failed. Check your network and try again.");
  }
  if (response.ok) {
    try {
      return await response.json();
    } catch {
      throw new PollinationsError("invalid", "Pollinations returned an invalid response.");
    }
  }
  // Device-flow pending states arrive as HTTP 400 with a JSON body.
  if (url.startsWith(ENTER + "/api/device/")) {
    let parsed: { error?: string } | undefined;
    try {
      parsed = (await response.json()) as { error?: string };
    } catch {
      /* fall through to generic error */
    }
    if (parsed && typeof parsed.error === "string") return parsed;
  }
  if (response.status === 401) {
    throw new PollinationsError("auth", "Authorization expired or was revoked. Connect your account again.");
  }
  if (response.status === 402) {
    throw new PollinationsError("payment", "Not enough Pollen for this request. Top up your Pollinations account.");
  }
  if (response.status === 403) {
    throw new PollinationsError("auth", "Access denied. Check the model permissions on your Pollinations account.");
  }
  if (response.status === 429) {
    throw new PollinationsError("rate_limit", "Rate limit reached. Wait a moment and try again.");
  }
  throw new PollinationsError("api", `Pollinations returned HTTP ${response.status}.`);
}

/** Readable model label like "flux [flux.1.1-pro]". */
export function modelLabel(model: ImageModel): string {
  const alias = modelAliases(model);
  return alias.length > 0 ? `${model.name} [${alias.join(", ")}]` : model.name;
}

/** Optional short aliases from the catalog entry. */
export function modelAliases(model: ImageModel): string[] {
  const raw = model.aliases;
  return Array.isArray(raw) ? raw.filter((a): a is string => typeof a === "string") : [];
}

/** True when the model accepts an input image (edit workflows). */
export function supportsImageInput(model: ImageModel): boolean {
  return Array.isArray(model.input_modalities) && model.input_modalities.includes("image");
}

/** Filter the raw catalog down to image-out models (drop video). */
export function filterImageModels(catalog: unknown): ImageModel[] {
  if (!Array.isArray(catalog)) return [];
  return (catalog as unknown[]).filter(
    (entry): entry is ImageModel =>
      entry !== null && typeof entry === "object" &&
      typeof (entry as ImageModel).name === "string" &&
      Array.isArray((entry as ImageModel).output_modalities) &&
      (entry as ImageModel).output_modalities!.includes("image") &&
      !(entry as ImageModel).output_modalities!.includes("video"),
  );
}

/** Load the live image model catalog. */
export async function loadModels(token?: string): Promise<ImageModel[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers["Authorization"] = "Bearer " + token;
  let response: SimpleResponse;
  try {
    response = await httpFetch()(GEN + "/image/models", { method: "GET", headers });
  } catch (error) {
    if (error instanceof PollinationsError) throw error;
    throw new PollinationsError("network", "Could not load the model catalog. Check your network.");
  }
  if (!response.ok) {
    throw new PollinationsError("api", `Model catalog returned HTTP ${response.status}.`);
  }
  return filterImageModels(await response.json());
}

/** Step 1 of BYOP: create a device code for the user to approve in a browser. */
export async function beginAuthorization(): Promise<DeviceCode> {
  const result = await requestJson(ENTER + "/api/device/code", { client_id: CLIENT_ID });
  const code = result as Partial<DeviceCode> | null;
  if (
    !code ||
    typeof code.device_code !== "string" ||
    typeof code.user_code !== "string" ||
    typeof code.verification_uri !== "string" ||
    typeof code.expires_in !== "number"
  ) {
    throw new PollinationsError("invalid", "Invalid device authorization response.");
  }
  return code as DeviceCode;
}

/**
 * Step 2 of BYOP: one token poll. Returns the pending/denied/expired state or
 * the access token. The caller controls the retry loop so the UI stays alive.
 */
export async function pollAuthorizationOnce(code: DeviceCode): Promise<DevicePollState> {
  const result = await requestJson(ENTER + "/api/device/token", { device_code: code.device_code });
  const body = result as { access_token?: unknown; error?: unknown } | null;
  if (body && typeof body.access_token === "string" && body.access_token.length > 0) {
    return { status: "done", access_token: body.access_token };
  }
  if (body && typeof body.error === "string") {
    if (body.error === "authorization_pending") return { status: "pending" };
    if (body.error === "slow_down") return { status: "slow_down" };
    if (body.error === "access_denied") return { status: "denied" };
    if (body.error === "expired_token") return { status: "expired" };
  }
  throw new PollinationsError("invalid", "Unexpected device token response.");
}

/** The approval URL the user opens (verification_uri_complete when present). */
export function approvalUrl(code: DeviceCode): string {
  return code.verification_uri_complete || code.verification_uri;
}

export interface GenerationResult {
  /** Raw binary image bytes (PNG unless the model says otherwise). */
  bytes: Uint8Array;
  /** Likely MIME type from the response, falling back to image/png. */
  mime: string;
}

export interface GenerateOptions {
  model: string;
  prompt: string;
  /** data: URL of the source image for edit workflows. */
  image?: string;
  width?: number;
  height?: number;
  /** Structural AbortSignal so this file stays free of DOM lib types. */
  signal?: { readonly aborted: boolean };
}

/** Generate or edit an image. Uses /edits when `image` is provided. */
export async function generateImage(
  token: string,
  options: GenerateOptions,
): Promise<GenerationResult> {
  const trimmed = options.prompt.trim();
  if (trimmed.length === 0) {
    throw new PollinationsError("invalid", "Enter a prompt first.");
  }
  const payload: Record<string, unknown> = { model: options.model, prompt: trimmed };
  if (typeof options.width === "number" && options.width > 0) payload.width = Math.round(options.width);
  if (typeof options.height === "number" && options.height > 0) payload.height = Math.round(options.height);
  const route = options.image === undefined ? "/v1/images/generations" : "/v1/images/edits";
  if (options.image !== undefined) payload.image = options.image;

  let response: SimpleResponse;
  try {
    response = await httpFetch()(GEN + route, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: "Bearer " + token,
      },
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof PollinationsError) throw error;
    throw new PollinationsError("network", "Generation connection failed. Check your network and try again.");
  }
  if (!response.ok) {
    if (response.status === 401) throw new PollinationsError("auth", "Authorization expired. Connect your account again.");
    if (response.status === 402) throw new PollinationsError("payment", "Not enough Pollen for this generation.");
    if (response.status === 403) throw new PollinationsError("auth", "Access denied for this model. Check your account permissions.");
    if (response.status === 429) throw new PollinationsError("rate_limit", "Rate limit reached. Wait a moment and try again.");
    throw new PollinationsError("api", `Generation returned HTTP ${response.status}.`);
  }
  const result = (await response.json()) as { data?: Array<{ b64_json?: unknown; url?: unknown; mime_type?: unknown }> };
  const first = result.data && result.data.length > 0 ? result.data[0] : undefined;
  if (!first || typeof first.b64_json !== "string" || first.b64_json.length === 0) {
    throw new PollinationsError("invalid", "Generation returned no image data.");
  }
  return {
    bytes: base64ToBytes(first.b64_json),
    mime: typeof first.mime_type === "string" && first.mime_type.length > 0 ? first.mime_type : "image/png",
  };
}

/** Base64 (with padding tolerance) to bytes. */
export function base64ToBytes(encoded: string): Uint8Array {
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atobUniversal(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function atobUniversal(data: string): string {
  const decode = (globalThis as { atob?: unknown }).atob;
  if (typeof decode === "function") return (decode as (input: string) => string)(data);
  throw new PollinationsError("invalid", "Base64 decoding is unavailable in this environment.");
}

/** Read bytes as a data: URL (for previewing and image-input payloads). */
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  const encode = (globalThis as { btoa?: unknown }).btoa;
  if (typeof encode !== "function") {
    throw new PollinationsError("invalid", "Base64 encoding is unavailable in this environment.");
  }
  return `data:${mime};base64,${(encode as (input: string) => string)(binary)}`;
}

/** PNG dimension probe: reads the IHDR at a fixed offset. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** JPEG dimension probe: scans SOF0-SOF15 markers (skipping DHT/quant tables). */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return {
        height: (bytes[offset + 5] << 8) | bytes[offset + 6],
        width: (bytes[offset + 7] << 8) | bytes[offset + 8],
      };
    }
    offset += 2 + length;
  }
  return null;
}

/** Best-effort pixel dimensions of a PNG or JPEG payload. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  return pngSize(bytes) ?? jpegSize(bytes);
}
