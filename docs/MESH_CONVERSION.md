# Turning imported meshes back into CAD surfaces

An imported STL is a triangle soup. It has no faces, no edges and no dimensions:
a cylindrical hole is a ring of narrow flat strips, and there is no radius
anywhere in the file to read. This pipeline recovers the planes, cylinders, cones
and spheres the part was originally made of.

> **Status.** Recognition and regularization are complete and tested. Rebuilding
> a solid from the recognised surfaces, and the user interface for it, are not
> built yet. See "What is not built yet".

## The pipeline — `lib/meshToBrep/`

### 1. Topology — `meshTopology.ts`

`importedMesh.positions` is non-indexed: every triangle carries its own three
vertices, so a cube arrives as 36 unrelated points. Welding them into shared
vertices is what makes "which triangles touch along an edge" answerable at all.

Welding checks the 27 cells around each vertex rather than just its own, so a
pair that straddles a grid boundary still finds each other — the failure mode
that makes naive grid hashing split a watertight mesh into two shells.

### 2. Segmentation — `segmentation.ts`

Splits the mesh into patches that each correspond to one surface.

Growing on the angle between neighbouring triangle normals does not work: on a
cylinder every neighbour differs by the tessellation angle, so the cylinder comes
apart into strips. Instead a candidate surface is fitted and triangles are
admitted by how well they match *that surface*, which is scale-independent.

That needs a starting fit, and a starting fit needs a wide patch — over a couple
of facets a cone, a cylinder and a plane all explain the data equally well. So
each patch begins by flooding across smooth transitions, stopping dead at real
edges, then alternates refit and regrow until it stops changing.

### 3. Fitting — `surfaceFit.ts`

Least squares for plane, cylinder, cone and sphere, weighted by triangle area
(a tessellation puts many small triangles where a surface curves and few large
ones where it is flat).

Cylinders and cones are recovered through the Gauss map. Every normal of a
cylinder is perpendicular to its axis, so the normals lie on a great circle and
the axis is the direction of least variance in the normal cloud. A cone's normals
lie on a *plane* offset from the origin, `n·axis = sin(halfAngle)`, so one plane
fit recovers both the axis and the half angle.

**Orientation is not optional.** Point distance alone cannot recognise anything:
the eight corners of a box lie exactly on a circumscribing cylinder, and every
vertex of a tessellated cone lies exactly on a sphere. Both fit with zero
residual. What separates them is the normals — a box face's normal is constant, a
cylinder's rotates — so fit quality measures orientation as well as position.

Surfaces have genuine singularities: a cone's apex and any point on a cylinder's
axis have no unique normal. Every triangle of a tessellated cone shares its apex
vertex, so those points are excluded from the orientation check rather than
answered with a guess.

### 4. Regularization — `regularize.ts`

This is what makes the output usable rather than a slightly-wrong copy of the
tessellation.

- **Direction clustering.** Normals and axes that agree within tolerance are
  replaced by their area-weighted mean, and optionally snapped to a world axis.
  Six faces whose normals disagree by fractions of a degree become three clean
  orthogonal directions.
- **Dimension rounding.** Radii and plane offsets snap to a grid, so a hole
  measured at 4.9987 comes out as 5.
- **Coaxiality.** Cylinders and cones whose axes are nearly the same line are
  pulled onto a shared one. Two holes drilled through a part are meant to be
  coaxial; a hundredth of a millimetre apart produces a body that cannot be
  filleted.

## Using it

```ts
import { analyzeMeshForConversion, describeConversion } from "@/lib/meshToBrep";

const analysis = analyzeMeshForConversion(shape.importedMesh.positions, {
  tolerance: 0.05,       // mm, how far a triangle may sit off its surface
  angleTolerance: 12,    // degrees, how far its normal may point away
  snapToWorldAxes: true,
  dimensionGrid: 0.1,    // mm, rounding grid for radii and offsets
});

describeConversion(analysis);
// "2 planes, 1 cylinder — 100% of the surface."
```

`analysis.coverage` is the fraction of surface area actually recognised and
`analysis.unassignedTriangles` is exactly what was not, so the result can be
reported honestly instead of presenting a partial reconstruction as a finished
conversion. `analysis.manifold` says whether the mesh is closed and two-manifold,
which a solid rebuild requires.

## Choosing a tolerance

The tolerance is how far a triangle may sit from the surface it is assigned to.

- **Meshes exported from CAD** are the good case. They are exact within their
  chord tolerance, so anything a little above the export tolerance works;
  0.05 mm is a sensible default.
- **Too tight** and surfaces fragment into many small patches, or fail to be
  recognised at all and stay as triangles.
- **Too loose** and distinct surfaces merge, producing a body that is confidently
  wrong. Prefer starting tight and loosening.
- **Scanned or organic meshes** will not reconstruct into analytic surfaces, and
  should not. The coverage figure will be low, which is the honest answer.

## What is not built yet

- Extracting the boundary curves between recognised surfaces and fitting them to
  analytic lines and arcs.
- Assembling the surfaces into an OpenCascade solid, with a fallback ladder:
  analytic faces first; then sew plus coplanar-facet merging, which makes flat
  areas exact while curved ones stay faceted; then keeping the mesh with a report
  of which regions failed.
- The conversion panel, its live preview and its tolerance controls.
- Torus recognition.
