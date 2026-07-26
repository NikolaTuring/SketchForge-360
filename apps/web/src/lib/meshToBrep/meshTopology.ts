// Turns the triangle soup an STL import leaves behind into a connected mesh
// with adjacency, which is the prerequisite for recognising surfaces in it.
//
// `importedMesh.positions` is non-indexed: every triangle carries its own three
// vertices, so a cube arrives as 36 unrelated points. Welding them back into
// shared vertices is what makes "which triangles touch along an edge" answerable
// at all.

export type Vec3 = { x: number; y: number; z: number };

export type MeshTopology = {
  /** Welded vertex positions, 3 numbers per vertex. */
  vertices: Float64Array;
  vertexCount: number;
  /** Vertex indices, 3 per triangle. */
  triangles: Uint32Array;
  triangleCount: number;
  /** Unit face normal, 3 numbers per triangle. */
  normals: Float64Array;
  /** Triangle areas, used to weight surface fits toward the larger facets. */
  areas: Float64Array;
  /**
   * Neighbour triangle across each of a triangle's three edges, or -1 for a
   * boundary edge. Edge k joins triangle vertices k and (k + 1) % 3.
   */
  adjacency: Int32Array;
  /** Edges shared by more than two triangles; a sign the mesh is not manifold. */
  nonManifoldEdgeCount: number;
};

const DEFAULT_WELD_TOLERANCE = 1e-5;

function cellKey(x: number, y: number, z: number) {
  return `${x},${y},${z}`;
}

/**
 * Welds vertices onto a tolerance grid.
 *
 * Each vertex checks the 27 cells around its own, so a pair that straddles a
 * cell boundary still finds each other — the failure mode that makes naive grid
 * hashing split a watertight mesh into two shells.
 */
function weldVertices(positions: readonly number[], tolerance: number) {
  const cellSize = Math.max(tolerance, 1e-12) * 2;
  const buckets = new Map<string, number[]>();
  const vertices: number[] = [];
  const indexOf = new Uint32Array(positions.length / 3);
  const toleranceSquared = tolerance * tolerance;

  for (let offset = 0, vertex = 0; offset + 2 < positions.length; offset += 3, vertex += 1) {
    const x = positions[offset];
    const y = positions[offset + 1];
    const z = positions[offset + 2];
    const cellX = Math.floor(x / cellSize);
    const cellY = Math.floor(y / cellSize);
    const cellZ = Math.floor(z / cellSize);

    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx += 1) {
      for (let dy = -1; dy <= 1 && found < 0; dy += 1) {
        for (let dz = -1; dz <= 1 && found < 0; dz += 1) {
          const candidates = buckets.get(cellKey(cellX + dx, cellY + dy, cellZ + dz));
          if (!candidates) continue;
          for (const candidate of candidates) {
            const base = candidate * 3;
            const distanceSquared =
              (vertices[base] - x) ** 2 + (vertices[base + 1] - y) ** 2 + (vertices[base + 2] - z) ** 2;
            if (distanceSquared <= toleranceSquared) {
              found = candidate;
              break;
            }
          }
        }
      }
    }

    if (found < 0) {
      found = vertices.length / 3;
      vertices.push(x, y, z);
      const key = cellKey(cellX, cellY, cellZ);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(found);
      else buckets.set(key, [found]);
    }
    indexOf[vertex] = found;
  }

  return { vertices: Float64Array.from(vertices), indexOf };
}

export function buildMeshTopology(positions: readonly number[], weldTolerance = DEFAULT_WELD_TOLERANCE): MeshTopology {
  const { vertices, indexOf } = weldVertices(positions, weldTolerance);
  const rawTriangleCount = Math.floor(indexOf.length / 3);

  const triangles: number[] = [];
  const normals: number[] = [];
  const areas: number[] = [];

  for (let triangle = 0; triangle < rawTriangleCount; triangle += 1) {
    const a = indexOf[triangle * 3];
    const b = indexOf[triangle * 3 + 1];
    const c = indexOf[triangle * 3 + 2];
    // Welding collapses slivers into degenerate triangles; they carry no surface
    // information and would poison the normal-based segmentation.
    if (a === b || b === c || a === c) continue;

    const ax = vertices[a * 3];
    const ay = vertices[a * 3 + 1];
    const az = vertices[a * 3 + 2];
    const ux = vertices[b * 3] - ax;
    const uy = vertices[b * 3 + 1] - ay;
    const uz = vertices[b * 3 + 2] - az;
    const vx = vertices[c * 3] - ax;
    const vy = vertices[c * 3 + 1] - ay;
    const vz = vertices[c * 3 + 2] - az;

    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length <= 1e-14) continue;

    triangles.push(a, b, c);
    normals.push(nx / length, ny / length, nz / length);
    areas.push(length / 2);
  }

  const triangleCount = triangles.length / 3;
  const adjacency = new Int32Array(triangleCount * 3).fill(-1);
  const edgeMap = new Map<string, number[]>();
  let nonManifoldEdgeCount = 0;

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    for (let edge = 0; edge < 3; edge += 1) {
      const from = triangles[triangle * 3 + edge];
      const to = triangles[triangle * 3 + ((edge + 1) % 3)];
      const key = from < to ? `${from}_${to}` : `${to}_${from}`;
      const slot = triangle * 3 + edge;
      const existing = edgeMap.get(key);
      if (existing) existing.push(slot);
      else edgeMap.set(key, [slot]);
    }
  }

  edgeMap.forEach((slots) => {
    if (slots.length === 2) {
      adjacency[slots[0]] = Math.floor(slots[1] / 3);
      adjacency[slots[1]] = Math.floor(slots[0] / 3);
    } else if (slots.length > 2) {
      nonManifoldEdgeCount += 1;
    }
  });

  return {
    vertices,
    vertexCount: vertices.length / 3,
    triangles: Uint32Array.from(triangles),
    triangleCount,
    normals: Float64Array.from(normals),
    areas: Float64Array.from(areas),
    adjacency,
    nonManifoldEdgeCount,
  };
}

export function triangleVertex(topology: MeshTopology, triangle: number, corner: number): Vec3 {
  const index = topology.triangles[triangle * 3 + corner] * 3;
  return { x: topology.vertices[index], y: topology.vertices[index + 1], z: topology.vertices[index + 2] };
}

export function triangleNormal(topology: MeshTopology, triangle: number): Vec3 {
  const base = triangle * 3;
  return { x: topology.normals[base], y: topology.normals[base + 1], z: topology.normals[base + 2] };
}

export function triangleCentroid(topology: MeshTopology, triangle: number): Vec3 {
  const a = triangleVertex(topology, triangle, 0);
  const b = triangleVertex(topology, triangle, 1);
  const c = triangleVertex(topology, triangle, 2);
  return { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3 };
}

/** Whether the mesh is closed and two-manifold, which analytic rebuild needs. */
export function isManifold(topology: MeshTopology) {
  return topology.nonManifoldEdgeCount === 0 && topology.adjacency.every((neighbour) => neighbour >= 0);
}
