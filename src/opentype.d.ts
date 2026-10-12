// opentype.js ships no typings; this covers the part the app uses.
declare module "opentype.js" {
  export interface PathCommand {
    type: "M" | "L" | "Q" | "C" | "Z";
    x?: number;
    y?: number;
    x1?: number;
    y1?: number;
    x2?: number;
    y2?: number;
  }
  export interface Path {
    commands: PathCommand[];
  }
  export interface Glyph {
    index: number;
    xMin?: number;
    xMax?: number;
    advanceWidth?: number;
  }
  export class Font {
    constructor(options: Record<string, unknown>);
    unitsPerEm: number;
    ascender: number;
    descender: number;
    charToGlyph(char: string): Glyph;
    getPath(text: string, x: number, y: number, fontSize: number): Path;
    toArrayBuffer(): ArrayBuffer;
  }
  export class Glyph {
    constructor(options: Record<string, unknown>);
  }
  export class Path {
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    close(): void;
  }
  export function parse(buffer: ArrayBuffer): Font;
}
