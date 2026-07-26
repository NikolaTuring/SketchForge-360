// Turning a kernel-built body into a scene body.
//
// The kernel works in world millimetres; a `WorkplaneShape` carries geometry in
// its own local frame plus a placement. Getting the conversion wrong does not
// error — it puts the body somewhere else — so it lives here with tests rather
// than inline in a click handler.

import type { BrepFeatureBody } from "@/lib/brepFeatureTypes";
import type { CadBrepFrame, CadDisplayEdge, WorkplaneShape } from "@/types/sketchforge";

/**
 * Expands an indexed mesh into the non-indexed triangle soup a
 * `WorkplaneShape` stores.
 *
 * `importedMesh.positions` is a soup everywhere else in the editor — the STL
 * importer produces one, the viewport expects one, and the surface recogniser
 * reads one. Storing an indexed mesh here instead would work until the first
 * piece of code that assumed nine numbers per triangle.
 */
export function expandIndexedMesh(positions: Float32Array, indices: Uint32Array) {
  const expanded = new Array<number>(indices.length * 3);
  for (let slot = 0; slot < indices.length; slot += 1) {
    const vertex = indices[slot] * 3;
    expanded[slot * 3] = positions[vertex];
    expanded[slot * 3 + 1] = positions[vertex + 1];
    expanded[slot * 3 + 2] = positions[vertex + 2];
  }
  return expanded;
}

export type ParametricBodyOptions = {
  id: string;
  name: string;
  color?: string;
  /** Kept when rebuilding an existing body so its place in the tree survives. */
  existing?: WorkplaneShape | null;
};

/**
 * Builds the scene body for a feature result.
 *
 * The mesh is moved into a local frame whose x and z are centred and whose y
 * starts at zero, because that is the frame every other body in the scene uses;
 * the offset that was removed becomes the body's placement. `cadBrepFrame`
 * records that placement so the exporter can undo it and emit the geometry
 * where the kernel actually built it.
 */
export function workplaneShapeFromFeatureBody(body: BrepFeatureBody, options: ParametricBodyOptions): WorkplaneShape {
  const soup = expandIndexedMesh(body.positions, body.indices);

  const width = Math.max(0.01, body.bounds.width);
  const depth = Math.max(0.01, body.bounds.depth);
  const height = Math.max(0.01, body.bounds.height);

  const centerX = body.bounds.center.x;
  const centerZ = body.bounds.center.z;
  const baseY = body.bounds.center.y - height / 2;

  for (let index = 0; index + 2 < soup.length; index += 3) {
    soup[index] -= centerX;
    soup[index + 1] -= baseY;
    soup[index + 2] -= centerZ;
  }

  const displayEdges: CadDisplayEdge[] = body.displayEdges.map((edge) => {
    const points = [...edge.points];
    for (let index = 0; index + 2 < points.length; index += 3) {
      points[index] -= centerX;
      points[index + 1] -= baseY;
      points[index + 2] -= centerZ;
    }
    return { points };
  });

  const frame: CadBrepFrame = { x: centerX, z: centerZ, elevation: baseY, width, depth, height };

  return {
    id: options.id,
    name: options.name,
    kind: "mesh",
    color: options.color ?? options.existing?.color ?? "#3f7fbf",
    hole: options.existing?.hole,
    locked: options.existing?.locked,
    hidden: options.existing?.hidden,
    x: centerX,
    z: centerZ,
    elevation: baseY,
    size: Math.max(width, depth),
    width,
    depth,
    height,
    rotation: 0,
    importedMesh: {
      positions: soup,
      baseWidth: width,
      baseDepth: depth,
      baseHeight: height,
      triangleCount: Math.floor(soup.length / 9),
      sourceFormat: "step",
      // The exact geometry travels with the body, so a STEP export re-emits
      // what the kernel built instead of the tessellation, and an edge feature
      // applied later starts from the analytic solid.
      brepStep: body.stepText,
    },
    cadBrep: body.brep,
    cadBrepFrame: frame,
    cadDisplayEdges: displayEdges,
    cadDisplayEdgesVersion: 2,
    // A sketch body's dimensions come from its profile, so resizing must not
    // rescale the edge features that were applied to it.
    edgeResizeMode: "preserve",
  };
}
