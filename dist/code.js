"use strict";
(() => {
  // src/pollinations.ts
  var ENTER = "https://enter.pollinations.ai";
  var GEN = "https://gen.pollinations.ai";
  var CLIENT_ID = "pk_5drKIx9HHnvmdcqW";
  var PollinationsError = class extends Error {
    constructor(kind, message) {
      super(message);
      this.name = "PollinationsError";
      this.kind = kind;
    }
  };
  function httpFetch() {
    const candidate = globalThis.fetch;
    if (typeof candidate !== "function") {
      throw new PollinationsError("network", "fetch is unavailable in this environment.");
    }
    return candidate;
  }
  async function requestJson(url, payload, token) {
    const headers = { Accept: "application/json" };
    let body;
    if (payload !== void 0) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(payload);
    }
    if (token) headers["Authorization"] = "Bearer " + token;
    let response;
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
    if (url.startsWith(ENTER + "/api/device/")) {
      let parsed;
      try {
        parsed = await response.json();
      } catch {
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
  function modelLabel(model) {
    const alias = modelAliases(model);
    return alias.length > 0 ? `${model.name} [${alias.join(", ")}]` : model.name;
  }
  function modelAliases(model) {
    const raw = model.aliases;
    return Array.isArray(raw) ? raw.filter((a) => typeof a === "string") : [];
  }
  function filterImageModels(catalog) {
    if (!Array.isArray(catalog)) return [];
    return catalog.filter(
      (entry) => entry !== null && typeof entry === "object" && typeof entry.name === "string" && Array.isArray(entry.output_modalities) && entry.output_modalities.includes("image") && !entry.output_modalities.includes("video")
    );
  }
  async function loadModels(token) {
    const headers = { Accept: "application/json" };
    if (token) headers["Authorization"] = "Bearer " + token;
    let response;
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
  async function beginAuthorization() {
    const result = await requestJson(ENTER + "/api/device/code", { client_id: CLIENT_ID });
    const code = result;
    if (!code || typeof code.device_code !== "string" || typeof code.user_code !== "string" || typeof code.verification_uri !== "string" || typeof code.expires_in !== "number") {
      throw new PollinationsError("invalid", "Invalid device authorization response.");
    }
    return code;
  }
  async function pollAuthorizationOnce(code) {
    const result = await requestJson(ENTER + "/api/device/token", { device_code: code.device_code });
    const body = result;
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
  function approvalUrl(code) {
    return code.verification_uri_complete || code.verification_uri;
  }
  async function generateImage(token, options) {
    const trimmed = options.prompt.trim();
    if (trimmed.length === 0) {
      throw new PollinationsError("invalid", "Enter a prompt first.");
    }
    const payload = { model: options.model, prompt: trimmed };
    if (typeof options.width === "number" && options.width > 0) payload.width = Math.round(options.width);
    if (typeof options.height === "number" && options.height > 0) payload.height = Math.round(options.height);
    const route = options.image === void 0 ? "/v1/images/generations" : "/v1/images/edits";
    if (options.image !== void 0) payload.image = options.image;
    let response;
    try {
      response = await httpFetch()(GEN + route, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: "Bearer " + token
        },
        body: JSON.stringify(payload),
        signal: options.signal
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
    const result = await response.json();
    const first = result.data && result.data.length > 0 ? result.data[0] : void 0;
    if (!first || typeof first.b64_json !== "string" || first.b64_json.length === 0) {
      throw new PollinationsError("invalid", "Generation returned no image data.");
    }
    return {
      bytes: base64ToBytes(first.b64_json),
      mime: typeof first.mime_type === "string" && first.mime_type.length > 0 ? first.mime_type : "image/png"
    };
  }
  function base64ToBytes(encoded) {
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const binary = atobUniversal(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function atobUniversal(data) {
    const decode = globalThis.atob;
    if (typeof decode === "function") return decode(data);
    throw new PollinationsError("invalid", "Base64 decoding is unavailable in this environment.");
  }
  function bytesToDataUrl(bytes, mime) {
    let binary = "";
    const chunk = 32768;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
    }
    const encode = globalThis.btoa;
    if (typeof encode !== "function") {
      throw new PollinationsError("invalid", "Base64 encoding is unavailable in this environment.");
    }
    return `data:${mime};base64,${encode(binary)}`;
  }
  function pngSize(bytes) {
    const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 24) return null;
    for (let i = 0; i < 8; i += 1) {
      if (bytes[i] !== PNG_SIGNATURE[i]) return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  function jpegSize(bytes) {
    if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return null;
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 255) return null;
      const marker = bytes[offset + 1];
      if (marker === 216 || marker >= 208 && marker <= 215) {
        offset += 2;
        continue;
      }
      const length = bytes[offset + 2] << 8 | bytes[offset + 3];
      const isStartOfFrame = marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204;
      if (isStartOfFrame) {
        return {
          height: bytes[offset + 5] << 8 | bytes[offset + 6],
          width: bytes[offset + 7] << 8 | bytes[offset + 8]
        };
      }
      offset += 2 + length;
    }
    return null;
  }
  function imageSize(bytes) {
    return pngSize(bytes) ?? jpegSize(bytes);
  }

  // src/figma-placement.ts
  function imagePaint(hash, scaleMode = "FILL") {
    return { type: "IMAGE", scaleMode, imageHash: hash };
  }
  function positionAtViewportCenter(host2, node, width, height) {
    const center = host2.viewportCenter();
    node.x = Math.round(center.x - width / 2);
    node.y = Math.round(center.y - height / 2);
  }
  function placeGeneratedImage(host2, result, options) {
    const image = host2.createImage(result.bytes);
    const paint = imagePaint(image.hash, "FILL");
    const natural = imageSize(result.bytes) ?? { width: 1024, height: 1024 };
    const maxEdge = options.maxWidth && options.maxWidth > 0 ? options.maxWidth : 512;
    const scale = Math.min(1, maxEdge / Math.max(natural.width, natural.height));
    const width = Math.max(1, Math.round(natural.width * scale));
    const height = Math.max(1, Math.round(natural.height * scale));
    if (options.frameWithPrompt === true && typeof options.prompt === "string") {
      const pad = 16;
      const captionHeight = 24;
      const frame = host2.createFrame();
      frame.name = options.name;
      frame.resize(width + pad * 2, height + pad * 2 + captionHeight);
      frame.fills = [];
      const caption = host2.createText();
      caption.characters = "\u273F " + options.prompt;
      caption.fontSize = 11;
      caption.textAutoResize = "WIDTH_AND_HEIGHT";
      caption.fills = [{ type: "SOLID", opacity: 0.75 }];
      caption.x = pad;
      caption.y = pad;
      const rect2 = host2.createRectangle();
      rect2.name = options.name + " \xB7 image";
      rect2.resize(width, height);
      rect2.fills = [paint];
      rect2.x = pad;
      rect2.y = pad + captionHeight;
      host2.appendChild(frame, caption);
      host2.appendChild(frame, rect2);
      if (options.origin) {
        frame.x = Math.round(options.origin.x + options.origin.width + 40);
        frame.y = Math.round(options.origin.y);
      } else {
        positionAtViewportCenter(host2, frame, width + pad * 2, height + pad * 2 + captionHeight);
      }
      host2.appendToCurrentPage(frame);
      return {
        node: frame,
        width: width + pad * 2,
        height: height + pad * 2 + captionHeight,
        imageHash: image.hash
      };
    }
    const rect = host2.createRectangle();
    rect.name = options.name;
    rect.resize(width, height);
    rect.fills = [paint];
    if (options.origin) {
      rect.x = Math.round(options.origin.x + options.origin.width + 40);
      rect.y = Math.round(options.origin.y);
    } else {
      positionAtViewportCenter(host2, rect, width, height);
    }
    host2.appendToCurrentPage(rect);
    return { node: rect, width, height, imageHash: image.hash };
  }
  function applyImageToSelection(host2, selection, result) {
    const paint = imagePaint(host2.createImage(result.bytes).hash, "FILL");
    let applied = 0;
    for (const node of selection) {
      if (node !== null && typeof node === "object" && "fills" in node) {
        node.fills = [paint];
        applied += 1;
      }
    }
    return applied;
  }
  async function exportSelectionAsDataUrl(selection) {
    if (selection.length === 0) return null;
    const bytes = await selection[0].exportAsync({ format: "PNG" });
    return bytesToDataUrl(bytes, "image/png");
  }

  // src/code.ts
  function errorPayload(error) {
    if (error instanceof PollinationsError) {
      return { message: error.message, kind: error.kind };
    }
    if (error instanceof Error && error.message.length > 0) {
      return { message: error.message };
    }
    return { message: "Something went wrong. Check your connection and try again.", kind: "api" };
  }
  async function storeToken(token) {
    await figma.clientStorage.setAsync("pollinations_token", token);
  }
  async function storedToken() {
    const token = await figma.clientStorage.getAsync("pollinations_token");
    return typeof token === "string" && token.length > 0 ? token : null;
  }
  function host() {
    return {
      createImage: (bytes) => figma.createImage(bytes),
      createRectangle: () => figma.createRectangle(),
      createFrame: () => figma.createFrame(),
      createText: () => figma.createText(),
      appendChild: (parent, child) => parent.appendChild(child),
      appendToCurrentPage: (node) => figma.currentPage.appendChild(node),
      viewportCenter: () => figma.viewport.center
    };
  }
  function selectionNodes() {
    return Array.from(figma.currentPage.selection);
  }
  function reportSelection() {
    const selection = selectionNodes();
    const first = selection[0];
    const canExport = selection.length > 0 && first !== null && typeof first === "object" && "exportAsync" in first;
    figma.ui.postMessage({
      type: "selection",
      count: selection.length,
      canExport
    });
  }
  function nodeBounds(node) {
    if (node !== null && typeof node === "object" && "x" in node && "y" in node && "width" in node && "height" in node && typeof node.x === "number") {
      const bounds = node;
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    }
    return void 0;
  }
  async function handleModelLoad(token) {
    const models = await loadModels(token);
    const payload = models.map((model) => ({
      name: model.name,
      label: modelLabel(model),
      supportsImageInput: Array.isArray(model.input_modalities) && model.input_modalities.includes("image")
    }));
    figma.ui.postMessage({ type: "models", models: payload });
  }
  async function runGeneration(model, prompt, options) {
    const token = await storedToken();
    if (token === null) {
      throw new PollinationsError("auth", "Connect your Pollinations account first.");
    }
    const isEdit = options.editInPlace === true;
    let sourceDataUrl;
    if (isEdit) {
      const selection = selectionNodes();
      if (selection.length === 0) {
        throw new PollinationsError("invalid", "Select a layer to edit first.");
      }
      const dataUrl = await exportSelectionAsDataUrl(selection);
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
      height: options.height
    });
    if (isEdit && options.frameWithPrompt !== true) {
      const applied = applyImageToSelection(host(), selectionNodes(), result);
      figma.ui.postMessage({ type: "edited", applied });
      figma.notify(`Pollinations: updated ${applied} layer${applied === 1 ? "" : "s"} \u273F`);
      return;
    }
    const promptLabel = prompt.trim().slice(0, 60);
    const placement = placeGeneratedImage(host(), result, {
      name: `Pollinations \xB7 ${promptLabel || model}`,
      frameWithPrompt: options.frameWithPrompt,
      prompt: prompt.trim(),
      maxWidth: 512,
      origin: isEdit && selectionNodes().length > 0 ? nodeBounds(selectionNodes()[0]) : void 0
    });
    figma.viewport.scrollAndZoomIntoView([placement.node]);
    figma.ui.postMessage({
      type: isEdit ? "edited" : "generated",
      applied: isEdit ? 1 : void 0,
      name: placement.node.name,
      width: placement.width,
      height: placement.height
    });
    figma.notify("Pollinations image ready \u273F");
  }
  figma.showUI(__html__, { width: 340, height: 600, themeColors: true });
  figma.on("selectionchange", reportSelection);
  figma.ui.onmessage = (message) => {
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
            await handleModelLoad(await storedToken() || void 0);
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
              frameWithPrompt: message.frameWithPrompt
            });
            break;
          case "edit-selection":
            await runGeneration(message.model, message.prompt, {
              frameWithPrompt: message.frameWithPrompt,
              editInPlace: true
            });
            break;
        }
      } catch (error) {
        figma.ui.postMessage({ type: "error", ...errorPayload(error) });
        figma.ui.postMessage({ type: "status", status: "idle" });
      }
    })();
  };
})();
