# ✿ Pollinations for Figma

Generate and edit images with **[Pollinations](https://pollinations.ai)** directly inside Figma — paying with **your own Pollen** (BYOP: bring your own Pollen). No proxy, no shared key, no subscriptions. Your Pollinations account is connected once with a device code and every generation is billed to you, in Pollen.

> Quest: [#15572](https://github.com/pollinations/pollinations/issues/15572) — "Designers generate and edit images with Pollinations inside Figma, paying with their own Pollen."

## What it does

- **Generate** an image from a prompt onto a new layer on the current page (plain rectangle or a caption frame with the prompt baked in).
- **Edit the current selection** with any image-input model: the layer is exported to PNG, sent to `POST /v1/images/edits`, and the result is either painted back onto the selection or placed next to it.
- **Live model catalog** from `GET https://gen.pollinations.ai/image/models` — every image model on your account, with aliases and image-input capability flags.
- **Device-flow sign in**: a user code + one-click approval page. The token is stored in `figma.clientStorage` (per user, per machine) and never appears in the ui iframe, logs, or the repo.

## Install

1. Download this repo (or `git clone https://github.com/Guest453/pollinations-figma`).
2. In Figma: **Plugins → Development → Import plugin from manifest…** and pick `dist/manifest.json` (or run `npm install && npm run build` first and import the freshly built `dist/`).
3. Run the plugin from any draft file. Click **Connect Pollinations account**, approve the device code in the browser window that opens, and start generating.

Requirements: any Figma plan (plugin runs in Development mode from `dist/`), a Pollinations account with Pollen, Node 20+ only if you want to build/test the source yourself.

## Demo

1. **Connect** — open the plugin, hit *Connect Pollinations account*. A user code like `K7QW-2PXX` appears and the approval page opens at `enter.pollinations.ai/device`. Approve, and the plugin flips to the generator.
2. **Generate** — pick a model (e.g. `tongyi-mai/z-image-turbo`), type *"a tiny robot painting a mural, soft light"*, set 1024×1024, hit **Generate image**. A `Pollinations · …` rectangle with the image fill lands in the center of your viewport, selected and zoomed.
3. **Caption frames** — check *Add caption frame with prompt* and generate again: the image lands in a frame with a `✿ <prompt>` caption.
4. **Edit a selection** — select a layer, pick an image-input model (e.g. `microsoft/mai-image-2.6`), type *"make it neon on a dark background"* and hit **Edit current selection**. The selection is exported, edited by the model, and painted back onto the layer (or placed beside it when the caption option is on).

Pollen is spent on the Pollinations side per generation — check your account activity if a request fails.

## How it's built

```
manifest.json            Figma manifest (networkAccess allow-list, dynamic-page)
src/pollinations.ts      pure transport: models, generate/edit, device flow, codecs — no Figma imports
src/figma-placement.ts   layer creation + selection painting against a minimal host interface
src/code.ts              plugin controller: message wiring, token storage, error mapping
src/ui.html              ui iframe: device-flow approval (window.open), model picker, prompt UI
test/*.ts                unit + integration tests with mocked fetch / mocked figma global
scripts/postbuild.mjs    copies manifest.json + ui.html into dist/
```

- Network runs in the **document sandbox** (`code.js`) — `gen.pollinations.ai` is allow-listed via `manifest.json#networkAccess`. The token never enters the ui iframe.
- The ui iframe only talks to `enter.pollinations.ai` for the device-flow handshake; its iframe is a real browser context, so `window.open` shows the approval page directly.
- The transport and placement modules are Figma-free on purpose: `src/pollinations.ts` uses only `fetch`/`atob`/`btoa`, and `src/figma-placement.ts` targets a `FigmaHostLike` interface, which makes both honestly unit-testable.

## Verification (what was actually tested)

Run everything with:

```bash
npm install
npm run verify   # typecheck + tests + build
```

**Verified in CI / locally:**
- `npm run typecheck` — `tsc --noEmit` against `@figma/plugin-typings` passes.
- `npm run test` — node:test suites cover the Pollinations transport (request shapes, `/edits` routing, HTTP status → error-kind mapping, device-flow state machine, base64/codec round-trips, PNG/JPEG size probes) and the placement logic (sizing math, viewport centering, caption frames, selection painting) using a mocked `figma` global, plus an end-to-end pass through `src/code.ts` (boot → device flow → models → generate → edit-selection → error handling) with stubbed network.
- `npm run build` — emits `dist/` as a drop-in plugin folder (`manifest.json` + `code.js` + `ui.html`).

**Not verified here (honesty note):** the plugin has **not** been run inside the real Figma desktop/browser editor as part of this repo's automated checks — Figma cannot run headless in CI. The manifest follows the current `@figma/plugin-typings` schema and the exercised mocks mirror its documented API surface, but a human should do the 60-second smoke test from **Install → step 3** before publishing.

## Publishing to Figma Community (optional)

1. Make sure `dist/` is fresh (`npm run build`).
2. In the Figma desktop app, right-click the plugin under **Plugins → Development** → **Publish** (or open it and choose *Publish to Community* from the plugin menu).
3. Fill in the Community listing (name, description, `image` tag), keep the visibility you want, and submit for Figma's review. The review needs a working demo file — create one with a couple of generations from step 2 of the demo.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with Figma or Pollinations; uses the public Pollinations API and your own account.
