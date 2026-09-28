/**
 * Mock of the Figma plugin API surface used by figma-placement.ts.
 * Keeps the same call semantics so placement logic is exercised honestly.
 */

export interface MockNodeRecord {
  kind: "rect" | "frame" | "text";
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fills: unknown;
  children: MockNodeRecord[];
  characters: string;
  fontSize: number;
  textAutoResize: "NONE" | "WIDTH_AND_HEIGHT";
  resize(width: number, height: number): void;
  appendChild(child: MockNodeRecord): void;
}

export class MockFigmaHost {
  createdImages: Uint8Array[] = [];
  appends: MockNodeRecord[] = [];
  center = { x: 500, y: 400 };

  createImage(bytes: Uint8Array) {
    this.createdImages.push(bytes);
    return { hash: "img_" + this.createdImages.length };
  }

  createRectangle(): MockNodeRecord {
    return this.#makeNode("rect");
  }

  createFrame(): MockNodeRecord {
    return this.#makeNode("frame");
  }

  createText(): MockNodeRecord {
    return this.#makeNode("text");
  }

  appendChild(parent: MockNodeRecord, child: MockNodeRecord) {
    parent.children.push(child);
  }

  appendToCurrentPage(node: MockNodeRecord) {
    this.appends.push(node);
  }

  viewportCenter() {
    return { ...this.center };
  }

  #makeNode(kind: MockNodeRecord["kind"]): MockNodeRecord {
    const node: MockNodeRecord = {
      kind,
      name: "",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fills: [],
      children: [],
      characters: "",
      fontSize: 12,
      textAutoResize: "NONE",
      resize(width: number, height: number) {
        node.width = width;
        node.height = height;
      },
      appendChild(child: MockNodeRecord) {
        node.children.push(child);
      },
    };
    return node;
  }
}

/** 1x1-worth PNG header with the given pixel size faked into the IHDR. */
export function fakePngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** Minimal JPEG stream with an SOF0 marker carrying the given dimensions. */
export function fakeJpegBytes(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xdb, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x07, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff,
    0xff, 0xd9,
  ]);
}
