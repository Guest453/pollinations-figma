/**
 * Figma plugin controller (document sandbox side).
 *
 * Wires the ui iframe to the Pollinations transport and places results in the
 * document. Token lives in figma.clientStorage (BYOP — bring your own Pollen).
 * Network happens in the ui iframe; the sandbox only touches the document.
 */

import type { DeviceCode, ImageModel } from "./pollinations.ts";
import {
  PollinationsError,
  approvalUrl,
  beginAuthorization,
  generateImage,
  loadModels,
  modelLabel,
  pollAuthorizationOnce,
} from "./pollinations.ts";
import {
  type FigmaHostLike,
  type FigmaTextLike,
  applyImageToSelection,
  exportSelectionAsDataUrl,
  placeGeneratedImage,
} from "./figma-placement.ts";

type UiMessage =
  | { type: "load-models" }
  | { type: "begin-auth" }
  | { type: "poll-auth"; code: DeviceCode }
  | { type: "generate"; model: string; prompt: string; width?: number; height?: number; frameWithPrompt?: boolean }
  | { type: "edit-selection"; model: string; prompt: string; frameWithPrompt?: boolean }
  | { type: "ready" };

/** Error → user-facing message + optional kind for the ui to react to. */
function errorPayload(error: unknown): { message: string; kind?: string } {
  if (error instanceof PollinationsError) {
    return { message: error.message, kind: error.kind };
  }
  if (error instanceof Error && error.message.length > 0) {
    return { message: error.message };
  }
  return { message: "Something went wrong. Check your connection and try again.", kind: "api" };
}

async function storeToken(token: string): Promise<void> {
  await figma.clientStorage.setAsync("pollinations_token", token);
}

async function storedToken(): Promise<string | null> {
  const token = await figma.clientStorage.getAsync("pollinations_token");
  return typeof token === "string" && token.length > 0 ? token : null;
}

/** Narrow the global figma object down to the placement host surface. */
function host(): FigmaHostLike {
  return {
    createImage: (bytes) => figma.createImage(bytes),
    createRectangle: () => figma.createRectangle(),
    createFrame: () => figma.createFrame(),
    createText: () => figma.createText() as unknown as FigmaTextLike,
    appendChild: (parent, child) => (parent as unknown as { appendChild(child: unknown): void }).appendChild(child),
    appendToCurrentPage: (node) => figma.currentPage.appendChild(node as never),
    viewportCenter: () => figma.viewport.center,
  };
}

function selectionNodes(): unknown[] {
  return Array.from(figma.currentPage.selection) as unknown[];
}

function reportSelection(): void {
  const selection = selectionNodes();
  const first: unknown = selection[0];
  const canExport = selection.length > 0 && first !== null && typeof first === "object" && "exportAsync" in first;
  figma.ui.postMessage({
    type: "selection",
    count: selection.length,
    canExport,
  });
}

/** Best-effort bounds of a node for placing results next to it. */
function nodeBounds(node: unknown): { x: number; y: number; width: number; height: number } | undefined {
  if (
    node !== null && typeof node === "object" &&
    "x" in node && "y" in node && "width" in node && "height" in node &&
    typeof (node as { x: unknown }).x === "number"
  ) {
    const bounds = node as { x: number; y: number; width: number; height: number };
    return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }
  return undefined;
}

async function handleModelLoad(token?: string): Promise<void> {
  const models = await loadModels(token);
  const payload = models.map((model: ImageModel) => ({
    name: model.name,
    label: modelLabel(model),
    supportsImageInput:
      Array.isArray(model.input_modalities) && model.input_modalities.includes("image"),
  }));
  figma.ui.postMessage({ type: "models", models: payload });
}

/** Sandbox-side generation: token never leaves the document sandbox. */
async function runGeneration(
  model: string,
  prompt: string,
  options: { width?: number; height?: number; frameWithPrompt?: boolean; editInPlace?: boolean },
): Promise<void> {
  const token = await storedToken();
  if (token === null) {
    throw new PollinationsError("auth", "Connect your Pollinations account first.");
  }
  const isEdit = options.editInPlace === true;

  let sourceDataUrl: string | undefined;
  if (isEdit) {
    const selection = selectionNodes();
    if (selection.length === 0) {
      throw new PollinationsError("invalid", "Select a layer to edit first.");
    }
    const dataUrl = await exportSelectionAsDataUrl(selection as unknown as Parameters<typeof exportSelectionAsDataUrl>[0]);
    if (dataUrl === null) {
      throw new PollinationsError("invalid", "Could not export the selection.");
    }
    sourceDataUrl = dataUrl;
  }

  figma.ui.postMessage({ type: "status", status: "generating" });
  const result = await generateImage(token, {
    model,
    prompt,
    image: sourceDataUrl,
    width: options.width,
    height: options.height,
  });

  if (isEdit && options.frameWithPrompt !== true) {
    // In-place edit: paint the result onto the selected layers.
    const applied = applyImageToSelection(host(), selectionNodes(), result);
    figma.ui.postMessage({ type: "edited", applied });
    figma.notify(`Pollinations: updated ${applied} layer${applied === 1 ? "" : "s"} ✿`);
    return;
  }

  const promptLabel = prompt.trim().slice(0, 60);
  const placement = placeGeneratedImage(host(), result, {
    name: `Pollinations · ${promptLabel || model}`,
    frameWithPrompt: options.frameWithPrompt,
    prompt: prompt.trim(),
    maxWidth: 512,
    origin:
      isEdit && selectionNodes().length > 0
        ? nodeBounds(selectionNodes()[0])
        : undefined,
  });
  figma.viewport.scrollAndZoomIntoView([placement.node as never]);
  figma.ui.postMessage({
    type: isEdit ? "edited" : "generated",
    applied: isEdit ? 1 : undefined,
    name: placement.node.name,
    width: placement.width,
    height: placement.height,
  });
  figma.notify("Pollinations image ready ✿");
}

figma.showUI(__html__, { width: 340, height: 600, themeColors: true });

figma.on("selectionchange", reportSelection);

figma.ui.onmessage = (message: UiMessage | undefined) => {
  if (!message) return;
  void (async () => {
    try {
      switch (message.type) {
        case "ready": {
          const token = await storedToken();
          figma.ui.postMessage({ type: "boot", token: token ?? "", hasToken: token !== null });
          reportSelection();
          break;
        }
        case "load-models":
          await handleModelLoad((await storedToken()) || undefined);
          break;
        case "begin-auth": {
          const code = await beginAuthorization();
          figma.ui.postMessage({ type: "auth-started", code, approvalUrl: approvalUrl(code) });
          break;
        }
        case "poll-auth": {
          const state = await pollAuthorizationOnce(message.code);
          if (state.status === "done") {
            await storeToken(state.access_token);
          }
          figma.ui.postMessage({ type: "auth-poll", state });
          break;
        }
        case "generate":
          await runGeneration(message.model, message.prompt, {
            width: message.width,
            height: message.height,
            frameWithPrompt: message.frameWithPrompt,
          });
          break;
        case "edit-selection":
          await runGeneration(message.model, message.prompt, {
            frameWithPrompt: message.frameWithPrompt,
            editInPlace: true,
          });
          break;
      }
    } catch (error) {
      figma.ui.postMessage({ type: "error", ...errorPayload(error) });
      figma.ui.postMessage({ type: "status", status: "idle" });
    }
  })();
};
