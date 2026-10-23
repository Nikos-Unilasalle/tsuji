import { BALL_STRIDE, finishMesh, MeshBuffers, MetaballsJob, uvAndBounds } from "./marchingCubes";
import { BLOB_STRIDE, blobGrid, BlobsJob } from "./surfaceNets";

/**
 * The Rust build of the geometry kernels (wasm/kernels, built by
 * `npm run build:wasm` into tsuji_kernels.wasm next to this file). Same
 * job in, same MeshBuffers out as the JS kernels, so the worker can run
 * either — see docs/offthread-geometry.md for which and why.
 */
export interface WasmKernels {
  metaballs(job: MetaballsJob): MeshBuffers;
  blobs(job: BlobsJob): MeshBuffers;
}

interface Exports {
  memory: WebAssembly.Memory;
  balls_ptr(count: number): number;
  metaballs(resolution: number, isolation: number, ballCount: number, maxVertices: number): number;
  position_ptr(): number;
  normal_ptr(): number;
  blob_elements_ptr(count: number): number;
  blobs(
    nx: number, ny: number, nz: number,
    originX: number, originY: number, originZ: number, cell: number,
    iso: number, elementCount: number, maxVertices: number, maxIndices: number, colors: number,
  ): number;
  blob_index_count(): number;
  blob_position_ptr(): number;
  blob_normal_ptr(): number;
  blob_color_ptr(): number;
  blob_index_ptr(): number;
}

function wrap(instance: WebAssembly.Instance): WasmKernels {
  const wasm = instance.exports as unknown as Exports;
  return {
    metaballs(job) {
      const ballCount = Math.floor(job.balls.length / BALL_STRIDE);
      const ballsAt = wasm.balls_ptr(ballCount);
      // Views are taken after every call that may grow memory: growth detaches the old buffer.
      new Float64Array(wasm.memory.buffer, ballsAt, ballCount * BALL_STRIDE).set(job.balls.subarray(0, ballCount * BALL_STRIDE));
      const count = wasm.metaballs(job.resolution, job.isolation, ballCount, job.maxVertices);
      const position = new Float32Array(wasm.memory.buffer, wasm.position_ptr(), count * 3);
      const normal = new Float32Array(wasm.memory.buffer, wasm.normal_ptr(), count * 3);
      // finishMesh copies out of linear memory, so the result can be transferred.
      return finishMesh(position, normal, count, job);
    },
    blobs(job) {
      // The grid is laid out here, once, so both kernels sample exactly the same points.
      const grid = blobGrid(job);
      if (!grid) return uvAndBounds(new Float32Array(0), new Float32Array(0), 0, job.uvDensity);
      const elementCount = Math.floor(job.elements.length / BLOB_STRIDE);
      const at = wasm.blob_elements_ptr(elementCount);
      new Float64Array(wasm.memory.buffer, at, elementCount * BLOB_STRIDE).set(job.elements.subarray(0, elementCount * BLOB_STRIDE));
      const count = wasm.blobs(
        grid.nx, grid.ny, grid.nz,
        grid.originX, grid.originY, grid.originZ, grid.cell,
        job.iso, elementCount, job.maxVertices, job.maxIndices, job.colors ? 1 : 0,
      );
      const indexCount = wasm.blob_index_count();
      // slice() copies out of linear memory, so the result can be transferred.
      const buffer = wasm.memory.buffer;
      const position = new Float32Array(buffer, wasm.blob_position_ptr(), count * 3).slice();
      const normal = new Float32Array(buffer, wasm.blob_normal_ptr(), count * 3).slice();
      const color = job.colors ? new Float32Array(buffer, wasm.blob_color_ptr(), count * 3).slice() : undefined;
      const index = new Uint32Array(buffer, wasm.blob_index_ptr(), indexCount).slice();
      return { ...uvAndBounds(position, normal, count, job.uvDensity), index, color };
    },
  };
}

/** For a worker or Node: compiles synchronously (a browser main thread refuses modules over 4 KB this way). */
export function instantiateWasmKernelsSync(bytes: BufferSource): WasmKernels {
  return wrap(new WebAssembly.Instance(new WebAssembly.Module(bytes), {}));
}

export async function instantiateWasmKernels(source: BufferSource | Response | Promise<Response>): Promise<WasmKernels> {
  if (source instanceof Response || source instanceof Promise) {
    const response = await source;
    return wrap((await WebAssembly.instantiate(await response.arrayBuffer(), {})).instance);
  }
  return wrap((await WebAssembly.instantiate(source, {})).instance);
}
