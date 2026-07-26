// The message protocol for the B-Rep feature worker.
//
// Kept apart from both the worker and its client so neither imports the other:
// a worker module that reaches into the main thread's code drags the whole
// editor into the worker bundle.
//
// This worker is separate from `cadModifier.worker.ts` on purpose. That one
// holds a prepared solid and its edge handles across several messages — a
// session — and interleaving unrelated feature builds with it would mean two
// kinds of state in one arena, where one operation's failure resets the other's
// work.

import type { MeshConversionSettings, SurfaceTally } from "@/lib/meshToBrep";
import type { ExtrudeRequest, RevolveRequest, SketchFeatureOperation } from "@/lib/brepSketchFeatures";
import type { Sketch } from "@/types/sketch";

/** Deflection for the display wireframe, in millimetres. */
export const FEATURE_WIREFRAME_DEFLECTION = 0.035;

/** How long the client waits before giving up on a request. */
export const BREP_FEATURE_TIMEOUT_MS = 45_000;

export type BrepFeatureBounds = {
  width: number;
  depth: number;
  height: number;
  center: { x: number; y: number; z: number };
};

/** A built body, in the form the editor needs to make a `WorkplaneShape`. */
export type BrepFeatureBody = {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  triangleCount: number;
  /** OpenCascade B-Rep text: the exact geometry, kept for later edge features. */
  brep: string;
  /**
   * STEP text for the same body.
   *
   * Carried alongside the B-Rep so the existing exporter can emit exact
   * geometry for a sketch body without a second trip through the kernel.
   */
  stepText: string;
  displayEdges: { points: number[] }[];
  volume: number;
  bounds: BrepFeatureBounds;
};

export type SketchFeatureBuild = {
  sketch: Sketch;
  /** Regions to use, by their loop signature; null means every closed region. */
  regionKeys: string[] | null;
  operation: SketchFeatureOperation;
  extrude?: ExtrudeRequest;
  revolve?: RevolveRequest;
  /** Existing body to combine with, as B-Rep text. Required unless "new". */
  targetBrep?: string;
};

/** One planar face of a body, for picking a sketch plane off a solid. */
export type PlanarFaceInfo = {
  index: number;
  origin: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  area: number;
};

export type MeshConversionReport = {
  tally: SurfaceTally;
  coverage: number;
  manifold: boolean;
  triangleCount: number;
  unassignedTriangles: number;
  /** Why a mesh is not closed, when it is not: named so the panel can say so. */
  boundaryEdges: number;
  nonManifoldEdges: number;
  /** Regularization detail, so the panel can say what was cleaned up. */
  directionClusters: number;
  axesSnappedToWorld: number;
  dimensionsRounded: number;
  coaxialGroups: number;
  summary: string;
};

export type BrepFeatureRequest =
  | { type: "sketch-feature"; requestId: number; build: SketchFeatureBuild }
  | { type: "planar-faces"; requestId: number; brep: string }
  | {
      type: "mesh-convert";
      requestId: number;
      positions: Float32Array;
      /** Only for an indexed mesh; an imported STL is a soup and omits it. */
      indices?: Uint32Array;
      settings: MeshConversionSettings;
    };

export type BrepFeatureResponse =
  | { type: "sketch-feature"; requestId: number; body: BrepFeatureBody }
  | { type: "planar-faces"; requestId: number; faces: PlanarFaceInfo[] }
  | { type: "mesh-convert"; requestId: number; report: MeshConversionReport }
  | {
      type: "error";
      requestId: number;
      message: string;
      /**
       * True when the kernel itself is gone rather than the request being
       * wrong. The client restarts the worker; a plain failure leaves it alone,
       * because tearing down a healthy worker over a bad extrude distance would
       * cost the next request a 22 MB reload.
       */
      fatal: boolean;
    };
