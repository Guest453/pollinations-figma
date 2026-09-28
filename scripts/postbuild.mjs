/**
 * Post-build: copy ui.html + manifest.json into dist/ so dist/ is a
 * drop-in Figma plugin folder (manifest.json + code.js + ui.html).
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(root, "dist"), { recursive: true });
copyFileSync(join(root, "manifest.json"), join(root, "dist", "manifest.json"));
copyFileSync(join(root, "src", "ui.html"), join(root, "dist", "ui.html"));
console.log("dist/ ready: manifest.json + code.js + ui.html");
