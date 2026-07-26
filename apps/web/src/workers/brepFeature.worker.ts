/// <reference lib="webworker" />

// The B-Rep feature worker: sketch features, planar-face listing, and mesh
// analysis.
//
// Everything here is slow enough to stutter the viewport if it ran on the main
// thread — an extrude against a fifty-face solid, or a segmentation pass over a
// hundred thousand triangles. The main thread stays free to keep drawing.
//
// Deliberately a second worker rather than more message types on
// `cadModifier.worker.ts`: that one keeps a prepared solid and its edge handles
// alive across messages, and a feature build failing in the same arena would
// reset a half-finished fillet the user is still adjusting.

import { buildSketchFeature, convertMesh, listPlanarFaces } from "@/lib/brepFeatureBuild";
import type { BrepFeatureRequest, BrepFeatureResponse } from "@/lib/brepFeatureTypes";
import { isCadModifierWasmMemoryFault } from "@/lib/cadModifierRuntime";
import { loadWorkerKernel, resetWorkerKernel } from "@/lib/occtWorkerKernel";

function post(message: BrepFeatureResponse, transfer: Transferable[] = []) {
  self.postMessage(message, { transfer });
}

self.onmessage = async (event: MessageEvent<BrepFeatureRequest>) => {
  const request = event.data;
  try {
    if (request.type === "mesh-convert") {
      // Pure geometry: no kernel, so this answers even while the wasm is still
      // downloading.
      post({ type: "mesh-convert", requestId: request.requestId, report: convertMesh(request.positions, request.settings, request.indices) });
      return;
    }

    const kernel = await loadWorkerKernel();

    if (request.type === "planar-faces") {
      post({ type: "planar-faces", requestId: request.requestId, faces: listPlanarFaces(kernel, request.brep) });
      return;
    }

    const body = buildSketchFeature(kernel, request.build);
    post({ type: "sketch-feature", requestId: request.requestId, body }, [
      body.positions.buffer,
      body.normals.buffer,
      body.indices.buffer,
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
    const name = error instanceof Error ? error.name : "";
    const fatal = isCadModifierWasmMemoryFault(message, name);
    if (fatal) {
      // The kernel is gone; forget it so the next request reloads rather than
      // failing against a dead module for the rest of the session.
      resetWorkerKernel();
    }
    post({
      type: "error",
      requestId: request.requestId,
      message: fatal ? "The CAD kernel hit a memory fault and reset. Try the feature again; no page refresh is needed." : message,
      fatal,
    });
  }
};
