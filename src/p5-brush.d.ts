// p5.brush ships no type declarations. Only the standalone build is used (no
// p5.js at runtime), and only the subset brushEngine.ts actually calls.
declare module "p5.brush/standalone" {
  export const DEGREES: "degrees";
  export const RADIANS: "radians";

  export function load(target?: HTMLCanvasElement | OffscreenCanvas): void;
  export function render(): void;
  export function clear(color?: string): void;
  export function angleMode(mode: "degrees" | "radians"): void;
  export function seed(value: number): void;
  export function noiseSeed(value: number): void;

  export function box(): string[];

  /** The tip surface a custom brush draws its shape on: a 2D canvas, origin centred, ±50 units across. */
  export interface TipSurface {
    drawingContext: CanvasRenderingContext2D;
    fill(value: number | string): void;
    noFill(): void;
    noStroke(): void;
    ellipse(x: number, y: number, w: number, h: number): void;
  }
  export interface BrushParams {
    type?: "default" | "spray" | "marker" | "custom" | "image";
    weight: number;
    scatter?: number;
    sharpness?: number;
    grain?: number;
    opacity: number;
    spacing: number;
    pressure?: number[] | ((t: number) => number) | { mode: "gaussian"; curve: [number, number]; min_max: [number, number] };
    tip?: (surface: TipSurface) => void;
    rotate?: "none" | "natural" | "random";
    markerTip?: boolean;
    noise?: number;
  }
  export function add(name: string, params: BrushParams): void | Promise<void>;
  export function scaleBrushes(factor: number): void;
  export function set(brushName: string, color: string, weight?: number): void;
  export function noStroke(): void;

  export function fill(color: string, opacity?: number): void;
  export function noFill(): void;
  export function fillBleed(strength: number, direction?: "in" | "out", angle?: number): void;
  export function fillTexture(textureStrength: number, borderIntensity: number, scatter?: boolean): void;
  export function wash(color: string, opacity?: number): void;
  export function noWash(): void;

  export interface HatchOptions {
    rand?: number | false;
    continuous?: boolean;
    gradient?: number | false;
  }
  export function hatch(distance: number, angle: number, options?: HatchOptions): void;
  export function hatchStyle(brushName: string, color: string, weight?: number): void;
  export function noHatch(): void;

  export function field(name: string): void;
  export function noField(): void;
  export function refreshField(time: number): void;
  export function listFields(): string[];
  export function wiggle(amount: number): void;

  export function beginShape(curvature?: number): void;
  export function vertex(x: number, y: number, pressure?: number): void;
  export function endShape(close?: boolean): unknown;
  export function spline(points: Array<[number, number] | [number, number, number]>, curvature?: number): unknown;
}
