// Guards the built plugin folder. This is the bug voodoohop caught: code.js
// calls figma.showUI(__html__) but the manifest lacked a "ui" field, so Figma
// would refuse to load the plugin.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

test("manifest points at the built code and ui files", () => {
    assert.equal(manifest.main, "code.js");
    assert.equal(manifest.ui, "ui.html");
});

test("manifest declares a ui file when the code calls figma.showUI", () => {
    const code = readFileSync(join(root, "src", "code.ts"), "utf8");
    if (code.includes("figma.showUI(__html__)")) {
        assert.ok(
            typeof manifest.ui === "string" && manifest.ui.length > 0,
            "code calls showUI(__html__) but manifest has no ui field",
        );
    }
});

test("postbuild copies exactly the files the manifest references", () => {
    const postbuild = readFileSync(join(root, "scripts", "postbuild.mjs"), "utf8");
    assert.ok(postbuild.includes('"ui.html"'), "postbuild must copy ui.html");
    assert.ok(
        postbuild.includes('"manifest.json"'),
        "postbuild must copy manifest.json",
    );
    assert.ok(
        existsSync(join(root, "src", "ui.html")),
        "src/ui.html must exist",
    );
});
