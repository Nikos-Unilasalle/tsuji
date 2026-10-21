import * as THREE from "three";
import { randomId } from "../randomId";
import { DEFAULT_REGISTRY } from "./nodes";
import { cloneParams } from "./cloneGraph";
import { Connection, NodeInstance } from "./types";

/** What a dropped file can be: the formats Image Texture, Audio Player, OBJ Model and glTF Model load. */
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "svg"];
const VIDEO_EXTENSIONS = ["mp4", "webm", "mov", "m4v"];
const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "flac", "m4a", "aac"];
const MODEL_EXTENSIONS = ["obj", "gltf", "glb", "fbx"];

export type DroppedKind = "image" | "video" | "audio" | "model";

export function droppedKind(name: string): DroppedKind | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (VIDEO_EXTENSIONS.includes(ext)) return "video";
  if (AUDIO_EXTENSIONS.includes(ext)) return "audio";
  if (MODEL_EXTENSIONS.includes(ext)) return "model";
  return null;
}

export function isDroppableImage(name: string): boolean {
  return droppedKind(name) === "image";
}

export function isDroppableMedia(name: string): boolean {
  return droppedKind(name) !== null;
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
 * What each dropped file becomes: an image is an Image Texture wired to a Texture to Plane; a video is the same, started with
 * the timeline; a sound is an Audio Player started with the timeline; a 3D model is an OBJ Model or a glTF Model. Each file is fed through its node's own file loader
 * (the path a manual pick takes), so it shows or sounds at once. Returns the nodes and wires to add to the graph.
 */
export function buildDroppedNodes(
  files: DroppedImage[],
  origin: { x: number; y: number },
): { nodes: NodeInstance[]; connections: Connection[] } {
  const imageDef = DEFAULT_REGISTRY.get("texture/image");
  const planeDef = DEFAULT_REGISTRY.get("texture/plane");
  const audioDef = DEFAULT_REGISTRY.get("sound/player");
  const objDef = DEFAULT_REGISTRY.get("object/obj");
  const gltfDef = DEFAULT_REGISTRY.get("object/gltf");
  const fbxDef = DEFAULT_REGISTRY.get("object/fbx");
  if (!imageDef || !planeDef || !audioDef || !objDef || !gltfDef || !fbxDef) return { nodes: [], connections: [] };

  const nodes: NodeInstance[] = [];
  const connections: Connection[] = [];
  let row = 0;
  let visual = 0;
  const load = (def: typeof imageDef, node: NodeInstance, file: DroppedImage) => {
    const field = def.dynamicParamFields?.(node).find((f) => f.id === "filePath");
    if (field && field.kind === "file") field.onLoaded?.(node.id, file.path, file.bytes);
  };

  for (const file of files) {
    const kind = droppedKind(file.path);
    if (!kind) continue;
    const y = origin.y + row * 220;
    row++;

    if (kind === "model") {
      const isObj = file.path.toLowerCase().endsWith(".obj");
      const def = isObj ? objDef : file.path.toLowerCase().endsWith(".fbx") ? fbxDef : gltfDef;
      const modelNode: NodeInstance = {
        id: randomId(),
        type: def.type,
        params: { ...cloneParams(def.defaultParams), filePath: file.path },
        position: { x: origin.x, y },
      };
      // An OBJ is text; a glTF/GLB/FBX goes in as the bytes it is (a .gltf's JSON is read from them just the same).
      const field = def.dynamicParamFields?.(modelNode).find((f) => f.id === "filePath");
      if (field && field.kind === "file") field.onLoaded?.(modelNode.id, file.path, isObj ? new TextDecoder().decode(file.bytes) : file.bytes);
      nodes.push(modelNode);
      continue;
    }

    if (kind === "audio") {
      const audioNode: NodeInstance = {
        id: randomId(),
        type: audioDef.type,
        // Anchored at frame 0 so it plays with the timeline; once, not looping.
        params: { ...cloneParams(audioDef.defaultParams), filePath: file.path, startFrame: 0, loop: 0 },
        position: { x: origin.x, y },
      };
      load(audioDef, audioNode, file);
      nodes.push(audioNode);
      continue;
    }

    const imageId = randomId();
    const planeId = randomId();
    const imageNode: NodeInstance = {
      id: imageId,
      type: imageDef.type,
      params: { ...cloneParams(imageDef.defaultParams), filePath: file.path, ...(kind === "video" ? { startFrame: 0 } : {}) },
      position: { x: origin.x, y },
    };
    const planeNode: NodeInstance = {
      id: planeId,
      type: planeDef.type,
      // Side by side in the scene too, so several pictures dropped together do not sit on top of each other.
      params: { ...cloneParams(planeDef.defaultParams), location: new THREE.Vector3(visual * 1.6, 0, 0) },
      position: { x: origin.x + 300, y },
    };
    visual++;
    load(imageDef, imageNode, file);
    nodes.push(imageNode, planeNode);
    connections.push({
      id: `${imageId}.texture->${planeId}.texture`,
      fromNode: imageId,
      fromSocket: "texture",
      toNode: planeId,
      toSocket: "texture",
    });
  }
  return { nodes, connections };
}
