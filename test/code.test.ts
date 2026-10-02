/**
 * Integration test for src/code.ts (the plugin controller) against a mocked
 * `figma` global. The controller is imported once; each test resets the mock
 * and drives it through ready → auth → models → generate → edit-selection.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { type MockNodeRecord, MockFigmaHost, fakePngBytes } from "./figma.mock.ts";

type AnyMessage = { type: string; [key: string]: unknown };

class FigmaGlobal extends MockFigmaHost {
  sent: AnyMessage[] = [];
  selection: unknown[] = [];
  zoomed: unknown[] = [];
  notified: string[] = [];
  appends: MockNodeRecord[] = [];
  declare createdImages: Uint8Array[];
  declare center: { x: number; y: number };
  onSelectionChange: (() => void) | null = null;
  #storage = new Map<string, string>();
  #messageHandler: ((message: unknown) => void) | null = null;

  showUI(html: string, options?: unknown) {
    this.sent.push({ type: "__showUI__", html, options: options as never });
  }

  on(event: string, handler: () => void) {
    if (event === "selectionchange") this.onSelectionChange = handler;
  }

  notify(message: string) {
    this.notified.push(message);
  }

  get ui() {
    const global = this;
    return {
      postMessage(message: AnyMessage) {
        global.sent.push(message);
      },
      set onmessage(handler: (message: unknown) => void) {
        global.#messageHandler = handler;
      },
    };
  }

  get clientStorage() {
    const storage = this.#storage;
    return {
      async setAsync(key: string, value: string) {
        storage.set(key, value);
      },
      async getAsync(key: string) {
        return storage.get(key) ?? null;
      },
    };
  }

  get currentPage() {
    const global = this;
    return {
      appendChild: (node: MockNodeRecord) => global.appends.push(node),
      selection: global.selection,
    };
  }

  get viewport() {
    const global = this;
    return {
      center: { ...global.center },
      scrollAndZoomIntoView(nodes: unknown[]) {
        global.zoomed.push(...nodes);
      },
    };
  }

  /** Dispatch a ui → sandbox message and flush the async handler. */
  async receive(message: unknown) {
    assert.ok(this.#messageHandler, "ui.onmessage handler was not registered");
    this.#messageHandler(message);
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  messageOf(type: string): AnyMessage {
    const message = this.sent.find((entry) => entry.type === type);
    assert.ok(
      message,
      `expected a ${type} message, got: ${JSON.stringify(this.sent).slice(0, 400)}`,
    );
    return message;
  }

  lastMessage(): AnyMessage {
    assert.ok(this.sent.length > 0, "no messages posted");
    return this.sent[this.sent.length - 1];
  }

  reset() {
    this.sent = [];
    this.selection = [];
    this.zoomed = [];
    this.notified = [];
    this.appends = [];
    this.createdImages = [];
    this.#storage.clear();
    // NOTE: #messageHandler is intentionally kept — it is registered once at
    // import time by the controller and must survive across tests.
  }
}

// Install the mock + ui html BEFORE importing the controller once.
const figma = new FigmaGlobal();
(globalThis as { figma?: unknown }).figma = figma;
(globalThis as { __html__?: string }).__html__ = "<html>ui</html>";
await import("../src/code.ts");

const PNG_B64 = Buffer.from(fakePngBytes(200, 100)).toString("base64");
const MODELS = [
  {
    name: "acme/dream-1",
    input_modalities: ["text", "image"],
    output_modalities: ["image"],
  },
];
const DEVICE_CODE = { device_code: "dc", user_code: "U", verification_uri: "v", expires_in: 60 };

function withFetch(handlers: Array<{ url: string; body: unknown; status?: number }>): () => void {
  const original = globalThis.fetch;
  (globalThis as { fetch?: unknown }).fetch = async (url: string | URL) => {
    const urlText = String(url);
    const match = handlers.find((h) => urlText.includes(h.url));
    assert.ok(match, `unexpected fetch to ${urlText}`);
    return new Response(JSON.stringify(match.body), { status: match.status ?? 200 });
  };
  return () => {
    (globalThis as { fetch?: unknown }).fetch = original;
  };
}

test("boots without a token and reports selection", async () => {
  figma.reset();
  await figma.receive({ type: "ready" });
  const boot = figma.messageOf("boot");
  assert.equal(boot.hasToken, false);
  assert.equal(figma.messageOf("selection").count, 0);
});

test("runs the full device flow and stores the token", async () => {
  figma.reset();
  const restore = withFetch([
    { url: "/api/device/code", body: DEVICE_CODE },
    { url: "/api/device/token", body: { access_token: "sk_flow_token" } },
  ]);
  try {
    await figma.receive({ type: "begin-auth" });
    const started = figma.messageOf("auth-started");
    assert.equal((started.code as { user_code: string }).user_code, "U");
    assert.equal(started.approvalUrl, "v");

    await figma.receive({ type: "poll-auth", code: DEVICE_CODE });
    const poll = figma.messageOf("auth-poll");
    assert.equal((poll.state as { status: string }).status, "done");
    assert.equal(await figma.clientStorage.getAsync("pollinations_token"), "sk_flow_token");
  } finally {
    restore();
  }
});

test("loads the model catalog into the ui", async () => {
  figma.reset();
  const restore = withFetch([{ url: "/image/models", body: MODELS }]);
  try {
    await figma.receive({ type: "load-models" });
    const models = figma.messageOf("models").models as Array<Record<string, unknown>>;
    assert.equal(models.length, 1);
    assert.equal(models[0].name, "acme/dream-1");
    assert.equal(models[0].supportsImageInput, true);
  } finally {
    restore();
  }
});

test("generate places a sized rectangle and zooms to it", async () => {
  figma.reset();
  await figma.clientStorage.setAsync("pollinations_token", "sk_gen");
  const restore = withFetch([
    { url: "/v1/images/generations", body: { data: [{ b64_json: PNG_B64 }] } },
  ]);
  try {
    await figma.receive({
      type: "generate",
      model: "acme/dream-1",
      prompt: "a cat astronaut",
      width: 1024,
      height: 1024,
    });
    assert.equal(figma.messageOf("generated").width, 200); // natural PNG size
    assert.equal(figma.messageOf("generated").height, 100);
    assert.equal(figma.appends.length, 1);
    const placed = figma.appends[0];
    assert.equal(placed.kind, "rect");
    assert.ok((placed.fills as Array<{ type: string }>)[0].type === "IMAGE");
    assert.equal(figma.zoomed.length, 1);
    assert.ok(figma.notified.some((entry) => entry.includes("ready")));
    assert.equal(figma.createdImages.length, 1);
  } finally {
    restore();
  }
});

test("generate with frameWithPrompt creates a caption frame", async () => {
  figma.reset();
  await figma.clientStorage.setAsync("pollinations_token", "sk_gen");
  const restore = withFetch([
    { url: "/v1/images/generations", body: { data: [{ b64_json: PNG_B64 }] } },
  ]);
  try {
    await figma.receive({ type: "generate", model: "m", prompt: "robot", frameWithPrompt: true });
    assert.ok(figma.messageOf("generated"), JSON.stringify(figma.sent).slice(0, 400));
    assert.equal(figma.appends.length, 1);
    const frame = figma.appends[0];
    assert.equal(frame.kind, "frame");
    assert.equal(frame.children.length, 2);
    assert.equal(frame.children[0].kind, "text");
    assert.equal(frame.children[0].characters, "✿ robot");
  } finally {
    restore();
  }
});

test("edit-selection paints the result onto the selected layers", async () => {
  figma.reset();
  await figma.clientStorage.setAsync("pollinations_token", "sk_edit");
  const selected = {
    name: "Poster",
    x: 0,
    y: 0,
    width: 50,
    height: 50,
    fills: [] as unknown,
    exportAsync: async () => fakePngBytes(50, 50),
  };
  figma.selection = [selected];
  const restore = withFetch([
    { url: "/v1/images/edits", body: { data: [{ b64_json: PNG_B64 }] } },
  ]);
  try {
    await figma.receive({ type: "edit-selection", model: "m", prompt: "make it neon" });
    assert.equal(figma.messageOf("edited").applied, 1);
    assert.equal((selected.fills as Array<{ type: string }>)[0].type, "IMAGE");
    assert.ok(figma.notified.some((entry) => entry.includes("updated 1 layer")));
  } finally {
    restore();
  }
});

test("surfaces a friendly error when no token is stored", async () => {
  figma.reset();
  await figma.receive({ type: "generate", model: "m", prompt: "cat" });
  const error = figma.messageOf("error");
  assert.match(String(error.message), /Connect your Pollinations account/);
  assert.equal(error.kind, "auth");
  assert.equal(figma.messageOf("status").status, "idle");
});

test("surfaces a friendly error when editing with an empty selection", async () => {
  figma.reset();
  await figma.clientStorage.setAsync("pollinations_token", "sk_edit");
  await figma.receive({ type: "edit-selection", model: "m", prompt: "make it pop" });
  const error = figma.messageOf("error");
  assert.match(String(error.message), /Select a layer to edit first/);
  assert.equal(error.kind, "invalid");
});
