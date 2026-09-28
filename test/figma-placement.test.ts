/**
 * Unit tests for layer-creation / placement logic using a mocked Figma host.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { GenerationResult } from "../src/pollinations.ts";
import {
  applyImageToSelection,
  type FigmaHostLike,
  imagePaint,
  placeGeneratedImage,
} from "../src/figma-placement.ts";
import { MockFigmaHost, type MockNodeRecord, fakePngBytes } from "./figma.mock.ts";

function result(bytes = fakePngBytes(800, 400)): GenerationResult {
  return { bytes, mime: "image/png" };
}

function asRecord(node: unknown): MockNodeRecord {
  return node as MockNodeRecord;
}

function hostLike(host: MockFigmaHost): FigmaHostLike {
  return host as unknown as FigmaHostLike;
}

test("imagePaint builds an IMAGE paint", () => {
  const paint = imagePaint("hash1");
  assert.equal(paint.type, "IMAGE");
  assert.equal(paint.imageHash, "hash1");
  assert.equal(paint.scaleMode, "FILL");
});

test("placeGeneratedImage creates a sized rectangle centered in the viewport", () => {
  const host = new MockFigmaHost();
  host.center = { x: 0, y: 0 };
  const placement = placeGeneratedImage(hostLike(host), result(), {
    name: "Pollinations · cat",
    maxWidth: 512,
  });
  assert.equal(host.createdImages.length, 1);
  assert.equal(host.appends.length, 1);
  // 800x400 scales to a 512 max edge → 512x256.
  assert.equal(placement.width, 512);
  assert.equal(placement.height, 256);
  assert.equal(placement.node.width, 512);
  assert.equal(placement.node.height, 256);
  assert.equal(placement.node.name, "Pollinations · cat");
  assert.equal(placement.node.x, -256);
  assert.equal(placement.node.y, -128);
  const fills = placement.node.fills as Array<{ type: string }>;
  assert.equal(fills[0].type, "IMAGE");
});

test("placeGeneratedImage never upscales beyond the natural size", () => {
  const host = new MockFigmaHost();
  const placement = placeGeneratedImage(hostLike(host), result(fakePngBytes(256, 128)), {
    name: "small",
    maxWidth: 512,
  });
  assert.equal(placement.width, 256);
  assert.equal(placement.height, 128);
});

test("placeGeneratedImage frame mode wraps image + caption and stacks children", () => {
  const host = new MockFigmaHost();
  const placement = placeGeneratedImage(hostLike(host), result(fakePngBytes(400, 200)), {
    name: "Pollinations · robot",
    frameWithPrompt: true,
    prompt: "a tiny robot",
  });
  const frame = asRecord(placement.node);
  assert.equal(frame.kind, "frame");
  assert.equal(frame.children.length, 2);
  const caption = frame.children[0];
  const image = frame.children[1];
  assert.equal(caption.kind, "text");
  assert.equal(caption.characters, "✿ a tiny robot");
  assert.equal(caption.fontSize, 11);
  assert.equal(image.kind, "rect");
  assert.equal((image.fills as Array<{ type: string }>)[0].type, "IMAGE");
  // 400x200 stays at natural size (maxEdge 512); frame adds 16px padding + 24px caption.
  assert.equal(placement.width, 432);
  assert.equal(placement.height, 256);
  assert.equal(frame.width, 432);
  assert.equal(frame.height, 256);
});

test("placeGeneratedImage places edits next to the source selection", () => {
  const host = new MockFigmaHost();
  const placement = placeGeneratedImage(hostLike(host), result(fakePngBytes(100, 100)), {
    name: "edit",
    origin: { x: 10, y: 20, width: 100, height: 100 },
  });
  assert.equal(placement.node.x, 150); // 10 + 100 + 40
  assert.equal(placement.node.y, 20);
});

test("applyImageToSelection paints every fillable layer and counts them", () => {
  const host = new MockFigmaHost();
  const rect = { fills: [] as unknown };
  const frame = { fills: [] as unknown };
  const text = { other: true };
  const applied = applyImageToSelection(host, [rect, null, text, frame], result());
  assert.equal(applied, 2);
  assert.equal((rect.fills as Array<{ type: string }>)[0].type, "IMAGE");
  assert.equal((frame.fills as Array<{ type: string }>)[0].type, "IMAGE");
  assert.equal(host.createdImages.length, 1, "exactly one image upload");
});

test("applyImageToSelection tolerates an empty selection", () => {
  const host = new MockFigmaHost();
  assert.equal(applyImageToSelection(host, [], result()), 0);
});
