/**
 * Layer creation + placement against a minimal Figma host interface.
 *
 * The real plugin passes a thin adapter over the global `figma` object; unit
 * tests pass plain object mocks. This module never touches Figma globals.
 */

import type { GenerationResult } from "./pollinations.ts";
import { bytesToDataUrl, imageSize } from "./pollinations.ts";

/** Structural image paint (matches Figma's ImagePaint without importing it). */
export interface ImagePaintLike {
  type: "IMAGE";
  scaleMode: "FILL" | "FIT" | "CROP" | "TILE";
  imageHash: string;
}

export interface FigmaNodeLike {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fills: unknown;
  resize(width: number, height: number): void;
}

export interface FigmaTextLike extends FigmaNodeLike {
  characters: string;
  fontSize: number;
  textAutoResize: "NONE" | "WIDTH_AND_HEIGHT";
}

/** Minimal surface of the Figma plugin API that placement needs. */
export interface FigmaHostLike {
  createImage(bytes: Uint8Array): { hash: string };
  createRectangle(): FigmaNodeLike;
  createFrame(): FigmaNodeLike;
  createText(): FigmaTextLike;
  /** Append `child` into `parent` (frame composition). */
  appendChild(parent: FigmaNodeLike, child: FigmaNodeLike): void;
  /** Add a top-level node to the current page. */
  appendToCurrentPage(node: FigmaNodeLike): void;
  viewportCenter(): { x: number; y: number };
}

export interface PlaceOptions {
  name: string;
  /** Wrap the image in a frame that captions it with the prompt. */
  frameWithPrompt?: boolean;
  prompt?: string;
  /** Longest edge of the placed node in canvas px (default 512). */
  maxWidth?: number;
  /** Place next to this origin instead of the viewport center. */
  origin?: { x: number; y: number; width: number; height: number };
}

export interface PlacementResult {
  node: FigmaNodeLike;
  width: number;
  height: number;
  imageHash: string;
}

export function imagePaint(hash: string, scaleMode: "FILL" | "FIT" = "FILL"): ImagePaintLike {
  return { type: "IMAGE", scaleMode, imageHash: hash };
}

export function positionAtViewportCenter(
  host: FigmaHostLike,
  node: FigmaNodeLike,
  width: number,
  height: number,
): void {
  const center = host.viewportCenter();
  node.x = Math.round(center.x - width / 2);
  node.y = Math.round(center.y - height / 2);
}

/**
 * Decode the generation result and place it on the current page: either as a
 * plain rectangle or as a frame with a prompt caption. Returns placement info.
 */
export function placeGeneratedImage(
  host: FigmaHostLike,
  result: GenerationResult,
  options: PlaceOptions,
): PlacementResult {
  const image = host.createImage(result.bytes);
  const paint = imagePaint(image.hash, "FILL");

  const natural = imageSize(result.bytes) ?? { width: 1024, height: 1024 };
  const maxEdge = options.maxWidth && options.maxWidth > 0 ? options.maxWidth : 512;
  const scale = Math.min(1, maxEdge / Math.max(natural.width, natural.height));
  const width = Math.max(1, Math.round(natural.width * scale));
  const height = Math.max(1, Math.round(natural.height * scale));

  if (options.frameWithPrompt === true && typeof options.prompt === "string") {
    const pad = 16;
    const captionHeight = 24;
    const frame = host.createFrame();
    frame.name = options.name;
    frame.resize(width + pad * 2, height + pad * 2 + captionHeight);
    frame.fills = [];

    const caption = host.createText();
    caption.characters = "✿ " + options.prompt;
    caption.fontSize = 11;
    caption.textAutoResize = "WIDTH_AND_HEIGHT";
    caption.fills = [{ type: "SOLID", opacity: 0.75 }];
    caption.x = pad;
    caption.y = pad;

    const rect = host.createRectangle();
    rect.name = options.name + " · image";
    rect.resize(width, height);
    rect.fills = [paint];
    rect.x = pad;
    rect.y = pad + captionHeight;

    host.appendChild(frame, caption);
    host.appendChild(frame, rect);

    if (options.origin) {
      frame.x = Math.round(options.origin.x + options.origin.width + 40);
      frame.y = Math.round(options.origin.y);
    } else {
      positionAtViewportCenter(host, frame, width + pad * 2, height + pad * 2 + captionHeight);
    }
    host.appendToCurrentPage(frame);
    return {
      node: frame,
      width: width + pad * 2,
      height: height + pad * 2 + captionHeight,
      imageHash: image.hash,
    };
  }

  const rect = host.createRectangle();
  rect.name = options.name;
  rect.resize(width, height);
  rect.fills = [paint];

  if (options.origin) {
    rect.x = Math.round(options.origin.x + options.origin.width + 40);
    rect.y = Math.round(options.origin.y);
  } else {
    positionAtViewportCenter(host, rect, width, height);
  }
  host.appendToCurrentPage(rect);
  return { node: rect, width, height, imageHash: image.hash };
}

/**
 * Apply a generated image as the fill of every selected layer that supports
 * fills. Returns how many layers were updated.
 */
export function applyImageToSelection(
  host: Pick<FigmaHostLike, "createImage">,
  selection: readonly unknown[],
  result: GenerationResult,
): number {
  const paint = imagePaint(host.createImage(result.bytes).hash, "FILL");
  let applied = 0;
  for (const node of selection) {
    if (node !== null && typeof node === "object" && "fills" in node) {
      (node as { fills: unknown }).fills = [paint];
      applied += 1;
    }
  }
  return applied;
}

export interface ExportableNode {
  /** Matches SceneNode.exportAsync for PNG exports. */
  exportAsync(settings: { format: "PNG" }): Promise<Uint8Array>;
}

/**
 * Export the first selected layer to a PNG data: URL for image-input models.
 * Returns null when the selection is empty.
 */
export async function exportSelectionAsDataUrl(
  selection: readonly ExportableNode[],
): Promise<string | null> {
  if (selection.length === 0) return null;
  const bytes = await selection[0].exportAsync({ format: "PNG" });
  return bytesToDataUrl(bytes, "image/png");
}
