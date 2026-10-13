import * as THREE from "three";
import { randomId } from "../randomId";
import { DEFAULT_REGISTRY } from "./nodes";
import { cloneParams } from "./cloneGraph";
import { Connection, NodeInstance } from "./types";

/** What a dropped file can be: the formats Image Texture loads. */
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "svg"];

export function isDroppableImage(name: string): boolean {
  return IMAGE_EXTENSIONS.includes(name.split(".").pop()?.toLowerCase() ?? "");
}

/**
 * The graph editor registers how to turn a screen point into a canvas position, so a drop on the node canvas lands where it
 * was released. A drop anywhere else (the 3D view) gets no position and is placed beside the existing nodes.
 */
let projector: ((clientX: number, clientY: number) => { x: number; y: number } | null) | null = null;

export function setDropProjector(fn: typeof projector): void {
  projector = fn;
}

export function projectDrop(clientX: number, clientY: number): { x: number; y: number } | null {
  return projector ? projector(clientX, clientY) : null;
}

export interface DroppedImage {
  /** The path stored in the node: the real path on the desktop, the bare file name in a browser. */
  path: string;
  bytes: Uint8Array;
}

/**
 * Image Texture + Texture to Plane, wired, for each dropped image. Each file is fed through the node's own file loader
 * (the path a manual pick takes), so it shows on screen at once. Returns the nodes and wires to add to the graph.
 */
export function buildImageNodes(
  images: DroppedImage[],
  origin: { x: number; y: number },
): { nodes: NodeInstance[]; connections: Connection[] } {
  const imageDef = DEFAULT_REGISTRY.get("texture/image");
  const planeDef = DEFAULT_REGISTRY.get("texture/plane");
  if (!imageDef || !planeDef) return { nodes: [], connections: [] };

  const nodes: NodeInstance[] = [];
  const connections: Connection[] = [];
  images.forEach((image, i) => {
    const imageId = randomId();
    const planeId = randomId();
    const y = origin.y + i * 220;
    const imageNode: NodeInstance = {
      id: imageId,
      type: imageDef.type,
      params: { ...cloneParams(imageDef.defaultParams), filePath: image.path },
      position: { x: origin.x, y },
    };
    const planeNode: NodeInstance = {
      id: planeId,
      type: planeDef.type,
      // Side by side in the scene too, so several images dropped together do not sit on top of each other.
      params: { ...cloneParams(planeDef.defaultParams), location: new THREE.Vector3(i * 1.6, 0, 0) },
      position: { x: origin.x + 300, y },
    };
    const field = imageDef.dynamicParamFields?.(imageNode).find((f) => f.id === "filePath");
    if (field && field.kind === "file") field.onLoaded?.(imageId, image.path, image.bytes);
    nodes.push(imageNode, planeNode);
    connections.push({
      id: `${imageId}.texture->${planeId}.texture`,
      fromNode: imageId,
      fromSocket: "texture",
      toNode: planeId,
      toSocket: "texture",
    });
  });
  return { nodes, connections };
}
