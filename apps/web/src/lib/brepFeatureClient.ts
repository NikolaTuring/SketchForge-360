"use client";

// Main-thread client for the B-Rep feature worker.
//
// Modelled on the edge-modifier client that already works, with one deliberate
// difference: requests here are independent, so this keeps a map of pending
// requests rather than a single "latest wins" slot. A user can start a mesh
// conversion and then draw a sketch while it runs, and neither should cancel
// the other.
//
// Every request carries a monotonic id. A reply whose id is not in the map is
// dropped — that is the entire staleness guard, and it is what stops a slow
// answer from a restarted worker landing on a request that has moved on.

import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  BREP_FEATURE_TIMEOUT_MS,
  type BrepFeatureBody,
  type BrepFeatureRequest,
  type BrepFeatureResponse,
  type MeshConversionReport,
  type PlanarFaceInfo,
  type SketchFeatureBuild,
} from "@/lib/brepFeatureTypes";
import type { MeshConversionSettings } from "@/lib/meshToBrep";

type Pending = {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class BrepFeatureError extends Error {
  /** True when the kernel reset; the same request is worth trying again. */
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "BrepFeatureError";
    this.retryable = retryable;
  }
}

function createWorker() {
  return new Worker(new URL("../workers/brepFeature.worker.ts", import.meta.url), { type: "module" });
}

/**
 * A worker connection that starts on first use and restarts after a crash.
 *
 * The worker is not created eagerly: it pulls in 22 MB of wasm on its first
 * kernel request, and someone who only ever moves primitives around should
 * never pay for that.
 */
class BrepFeatureConnection {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, Pending>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = createWorker();
    worker.onmessage = (event: MessageEvent<BrepFeatureResponse>) => this.receive(event.data);
    worker.onerror = () => this.failAll(new BrepFeatureError("The CAD worker stopped unexpectedly", true), true);
    this.worker = worker;
    return worker;
  }

  private receive(message: BrepFeatureResponse) {
    const entry = this.pending.get(message.requestId);
    // No entry means the request was abandoned or already timed out. Dropping
    // the reply is the point of the id.
    if (!entry) return;
    this.pending.delete(message.requestId);
    clearTimeout(entry.timer);

    if (message.type === "error") {
      if (message.fatal) this.restart();
      entry.reject(new BrepFeatureError(message.message, message.fatal));
      return;
    }
    const payload = message.type === "sketch-feature" ? message.body : message.type === "planar-faces" ? message.faces : message.report;
    (entry.resolve as (value: unknown) => void)(payload);
  }

  private failAll(error: BrepFeatureError, restart: boolean) {
    this.pending.forEach((entry) => {
      clearTimeout(entry.timer);
      entry.reject(error);
    });
    this.pending.clear();
    if (restart) this.restart();
  }

  private restart() {
    this.worker?.terminate();
    this.worker = null;
  }

  private send<T>(request: BrepFeatureRequest, transfer: Transferable[] = []): Promise<T> {
    const worker = this.ensureWorker();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        // A hung request means a hung kernel; the next one deserves a fresh
        // worker rather than a queue behind a wedged wasm module.
        this.restart();
        reject(new BrepFeatureError("The CAD worker did not answer in time", true));
      }, BREP_FEATURE_TIMEOUT_MS);

      this.pending.set(request.requestId, { resolve: resolve as Pending["resolve"], reject, timer });
      worker.postMessage(request, transfer);
    });
  }

  buildSketchFeature(build: SketchFeatureBuild): Promise<BrepFeatureBody> {
    return this.send({ type: "sketch-feature", requestId: this.nextRequestId++, build });
  }

  listPlanarFaces(brep: string): Promise<PlanarFaceInfo[]> {
    return this.send({ type: "planar-faces", requestId: this.nextRequestId++, brep });
  }

  convertMesh(positions: Float32Array, settings: MeshConversionSettings = {}, indices?: Uint32Array): Promise<MeshConversionReport> {
    // The buffers are copied rather than transferred: the caller's mesh is still
    // on screen, and handing away its backing store would blank the model.
    return this.send({
      type: "mesh-convert",
      requestId: this.nextRequestId++,
      positions: new Float32Array(positions),
      indices: indices ? new Uint32Array(indices) : undefined,
      settings,
    });
  }

  /** How many requests are still in flight, for a busy indicator. */
  get pendingCount() {
    return this.pending.size;
  }

  dispose() {
    this.failAll(new BrepFeatureError("The editor closed the CAD worker", false), false);
    this.restart();
  }
}

export type BrepFeatureApi = {
  buildSketchFeature: (build: SketchFeatureBuild) => Promise<BrepFeatureBody>;
  listPlanarFaces: (brep: string) => Promise<PlanarFaceInfo[]>;
  convertMesh: (positions: Float32Array, settings?: MeshConversionSettings, indices?: Uint32Array) => Promise<MeshConversionReport>;
};

/**
 * The worker, scoped to a component's lifetime.
 *
 * The connection is created lazily inside a ref rather than in an effect, so a
 * request made during the first render does not race the effect that would have
 * set it up.
 */
export function useBrepFeatureWorker(): BrepFeatureApi {
  const connectionRef = useRef<BrepFeatureConnection | null>(null);

  const connection = () => {
    connectionRef.current ??= new BrepFeatureConnection();
    return connectionRef.current;
  };

  useEffect(() => () => {
    connectionRef.current?.dispose();
    connectionRef.current = null;
  }, []);

  const buildSketchFeature = useCallback((build: SketchFeatureBuild) => connection().buildSketchFeature(build), []);
  const listPlanarFaces = useCallback((brep: string) => connection().listPlanarFaces(brep), []);
  const convertMesh = useCallback(
    (positions: Float32Array, settings?: MeshConversionSettings, indices?: Uint32Array) =>
      connection().convertMesh(positions, settings, indices),
    [],
  );

  return useMemo(
    () => ({ buildSketchFeature, listPlanarFaces, convertMesh }),
    [buildSketchFeature, convertMesh, listPlanarFaces],
  );
}
