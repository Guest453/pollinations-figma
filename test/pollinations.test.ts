/**
 * Unit tests for the pure Pollinations transport. Network is fully stubbed by
 * swapping globalThis.fetch; assertions cover request shapes and error mapping.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { DeviceCode, ImageModel } from "../src/pollinations.ts";
import {
  GEN,
  PollinationsError,
  base64ToBytes,
  beginAuthorization,
  bytesToDataUrl,
  filterImageModels,
  generateImage,
  imageSize,
  jpegSize,
  loadModels,
  modelLabel,
  pollAuthorizationOnce,
  pngSize,
  supportsImageInput,
} from "../src/pollinations.ts";
import { fakeJpegBytes, fakePngBytes } from "./figma.mock.ts";

type FetchCall = { url: string; init: Record<string, unknown> | undefined };

interface StubFetch {
  calls: FetchCall[];
  restore: () => void;
}

function stubFetch(responder: (url: string, init: Record<string, unknown> | undefined) => unknown): StubFetch {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  const fake = (url: string | URL, init?: Record<string, unknown>) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(responder(String(url), init) as Response);
  };
  (globalThis as { fetch?: unknown }).fetch = fake;
  return { calls, restore: () => { (globalThis as { fetch?: unknown }).fetch = original; } };
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

const MODEL: ImageModel = {
  name: "acme/dream-1",
  title: "Dream 1",
  input_modalities: ["text", "image"],
  output_modalities: ["image"],
};

// ---------- model catalog ----------

test("filterImageModels keeps image-out models and drops video-only entries", () => {
  const catalog = [
    MODEL,
    { name: "vid/motion", output_modalities: ["video"] },
    { name: "nope", output_modalities: "image" },
    null,
    // image+video hybrids are excluded too (they are video-first generators),
    // mirroring the reference GIMP plugin's filtering.
    { name: "multi", output_modalities: ["image", "video"] },
  ];
  const models = filterImageModels(catalog);
  assert.equal(models.length, 1);
  assert.equal(models[0].name, "acme/dream-1");
});

test("filterImageModels returns [] for garbage input", () => {
  assert.deepEqual(filterImageModels(undefined), []);
  assert.deepEqual(filterImageModels({}), []);
});

test("supportsImageInput reflects input_modalities", () => {
  assert.equal(supportsImageInput(MODEL), true);
  assert.equal(supportsImageInput({ ...MODEL, input_modalities: ["text"] }), false);
  assert.equal(supportsImageInput({ ...MODEL, input_modalities: undefined }), false);
});

test("modelLabel includes aliases when present", () => {
  assert.equal(modelLabel({ name: "acme/dream-1" }), "acme/dream-1");
  assert.equal(modelLabel({ name: "acme/dream-1", aliases: ["dream", "d1"] }), "acme/dream-1 [dream, d1]");
});

test("loadModels GETs /image/models and parses the catalog", async () => {
  const stub = stubFetch(() => jsonResponse(200, [MODEL]));
  try {
    const models = await loadModels();
    assert.equal(models.length, 1);
    assert.equal(stub.calls[0].url, GEN + "/image/models");
    const init = stub.calls[0].init ?? {};
    assert.equal(init.method, "GET");
  } finally {
    stub.restore();
  }
});

test("loadModels maps network failure to a PollinationsError", async () => {
  const stub = stubFetch(() => {
    throw new Error("boom");
  });
  try {
    await assert.rejects(
      loadModels(),
      (error: unknown) => error instanceof PollinationsError && error.kind === "network",
    );
  } finally {
    stub.restore();
  }
});

// ---------- image generation ----------

test("generateImage POSTs the documented payload to /v1/images/generations", async () => {
  const png = fakePngBytes(64, 32);
  const stub = stubFetch(() =>
    jsonResponse(200, { data: [{ b64_json: Buffer.from(png).toString("base64") }] }),
  );
  try {
    const result = await generateImage("sk_test", { model: "acme/dream-1", prompt: " a cat " });
    assert.deepEqual([...result.bytes], [...png]);
    assert.equal(result.mime, "image/png");
    const init = stub.calls[0].init ?? {};
    assert.equal(init.method, "POST");
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer sk_test");
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "acme/dream-1");
    assert.equal(body.prompt, "a cat"); // trimmed
    assert.ok(stub.calls[0].url.startsWith(GEN + "/v1/images/generations"));
  } finally {
    stub.restore();
  }
});

test("generateImage includes dimensions and routes image input to /v1/images/edits", async () => {
  const stub = stubFetch(() => jsonResponse(200, { data: [{ b64_json: "aGk=" }] }));
  try {
    await generateImage("sk_test", {
      model: "m",
      prompt: "make it blue",
      image: "data:image/png;base64,aGk=",
      width: 512,
      height: 256,
    });
    assert.ok(stub.calls[0].url.startsWith(GEN + "/v1/images/edits"));
    const body = JSON.parse(String((stub.calls[0].init ?? {}).body));
    assert.equal(body.image, "data:image/png;base64,aGk=");
    assert.equal(body.width, 512);
    assert.equal(body.height, 256);
  } finally {
    stub.restore();
  }
});

test("generateImage rejects empty prompts before hitting the network", async () => {
  await assert.rejects(
    generateImage("sk_test", { model: "m", prompt: "   " }),
    (error: unknown) => error instanceof PollinationsError && error.kind === "invalid",
  );
});

test("generateImage maps HTTP status codes to error kinds", async () => {
  const cases: Array<[number, PollinationsError["kind"]]> = [
    [401, "auth"],
    [402, "payment"],
    [403, "auth"],
    [429, "rate_limit"],
    [500, "api"],
  ];
  for (const [status, kind] of cases) {
    const stub = stubFetch(() => jsonResponse(status, { error: "x" }));
    try {
      await assert.rejects(
        generateImage("sk", { model: "m", prompt: "p" }),
        (error: unknown) => error instanceof PollinationsError && error.kind === kind,
      );
    } finally {
      stub.restore();
    }
  }
});

test("generateImage rejects responses without image data", async () => {
  const stub = stubFetch(() => jsonResponse(200, { data: [] }));
  try {
    await assert.rejects(
      generateImage("sk", { model: "m", prompt: "p" }),
      (error: unknown) => error instanceof PollinationsError && error.kind === "invalid",
    );
  } finally {
    stub.restore();
  }
});

// ---------- device flow ----------

test("beginAuthorization POSTs the publishable client id and validates the payload", async () => {
  const stub = stubFetch(() =>
    jsonResponse(200, {
      device_code: "dc_123",
      user_code: "ABCD-1234",
      verification_uri: "https://enter.pollinations.ai/device",
      verification_uri_complete: "https://enter.pollinations.ai/device?user_code=ABCD-1234",
      expires_in: 300,
      interval: 5,
    }),
  );
  try {
    const code = await beginAuthorization();
    assert.equal(code.device_code, "dc_123");
    assert.equal((stub.calls[0].init ?? {}).body, JSON.stringify({ client_id: "pk_5drKIx9HHnvmdcqW" }));
    assert.equal(stub.calls[0].url, "https://enter.pollinations.ai/api/device/code");
  } finally {
    stub.restore();
  }
});

test("beginAuthorization throws invalid on malformed payloads", async () => {
  const stub = stubFetch(() => jsonResponse(200, { device_code: 7 }));
  try {
    await assert.rejects(
      beginAuthorization(),
      (error: unknown) => error instanceof PollinationsError && error.kind === "invalid",
    );
  } finally {
    stub.restore();
  }
});

test("pollAuthorizationOnce maps pending, slow_down, denied, expired and success", async () => {
  const code: DeviceCode = {
    device_code: "dc_123",
    user_code: "X",
    verification_uri: "u",
    expires_in: 60,
  };
  const states = ["authorization_pending", "slow_down", "access_denied", "expired_token"];
  for (const state of states) {
    const stub = stubFetch(() => jsonResponse(400, { error: state }));
    try {
      const result = await pollAuthorizationOnce(code);
      assert.ok(result.status !== "done", state);
      assert.equal(result.status === "pending", state === "authorization_pending");
    } finally {
      stub.restore();
    }
  }
  const done = stubFetch(() => jsonResponse(200, { access_token: "sk_new" }));
  try {
    const result = await pollAuthorizationOnce(code);
    assert.deepEqual(result, { status: "done", access_token: "sk_new" });
  } finally {
    done.restore();
  }
});

// ---------- codecs ----------

test("base64ToBytes handles standard and URL-safe alphabets", () => {
  assert.deepEqual([...base64ToBytes("aGk=")], [0x68, 0x69]);
  assert.deepEqual([...base64ToBytes("aGk")], [0x68, 0x69]); // unpadded
  assert.deepEqual([...base64ToBytes("-e_-")], [...base64ToBytes("+e/+")]);
});

test("bytesToDataUrl round-trips through base64ToBytes", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251]);
  const dataUrl = bytesToDataUrl(bytes, "image/png");
  assert.equal(dataUrl.startsWith("data:image/png;base64,"), true);
  assert.deepEqual(
    [...base64ToBytes(dataUrl.slice("data:image/png;base64,".length))],
    [...bytes],
  );
});

// ---------- image dimension probes ----------

test("pngSize reads IHDR dimensions", () => {
  assert.deepEqual(pngSize(fakePngBytes(320, 240)), { width: 320, height: 240 });
  assert.equal(pngSize(new Uint8Array(10)), null);
  assert.equal(pngSize(fakeJpegBytes(2, 2)), null);
});

test("jpegSize scans SOF markers past table segments", () => {
  assert.deepEqual(jpegSize(fakeJpegBytes(640, 480)), { width: 640, height: 480 });
  assert.equal(jpegSize(fakePngBytes(2, 2)), null);
});

test("imageSize sniffs both formats", () => {
  assert.deepEqual(imageSize(fakePngBytes(32, 16)), { width: 32, height: 16 });
  assert.deepEqual(imageSize(fakeJpegBytes(16, 32)), { width: 16, height: 32 });
  assert.equal(imageSize(new Uint8Array(32)), null);
});
