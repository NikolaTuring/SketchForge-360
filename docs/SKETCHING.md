# The parametric sketcher

This describes the parametric sketching core: the data model, the constraint
solver, the profile finder and the B-Rep feature builders.

> **Status.** These modules are complete and tested, but they are not yet wired
> into the editor. The existing freehand sketch mode is unchanged and continues
> to work. See "What is not built yet" at the end.

## Why a solver at all

The freehand sketcher stores points and segments. You can draw a rectangle, but
nothing records that it *is* a rectangle — drag one corner and the other three
stay put. There is no way to say "these two edges are the same length" or "this
hole is 12 mm from that edge", and no way to change a dimension afterwards and
have the shape follow.

A constraint solver is what turns drawing into modelling. You state the
relationships you care about, the solver finds geometry that satisfies them, and
when you change a number it finds new geometry.

## The pieces

### Parameters — `lib/parameterExpressions.ts`

Named values with expressions: `wall = 2mm`, `inner = wall * 10`,
`total = inner + wall * 2`. Any dimension can be driven by one.

- Millimetres and degrees are canonical. A unit suffix converts at parse time, so
  `25mm + 1cm` is 35.
- Trigonometry works in degrees, because that is how a sketch angle reads.
- The parser is hand-written and never touches `eval` or `Function`. Expressions
  arrive from `.skf` files that may have been shared between machines, so they
  are untrusted input.
- Tables resolve in dependency order with cycle detection. One broken row reports
  its own error and leaves the rest of the table working.
- With no bracket in the expression, a comma is read as a decimal separator, so
  `12,5` keeps working. Once a function call is present, commas separate
  arguments.

### Sketch model — `types/sketch.ts`, `lib/sketchEntities.ts`

Entities live in plane-local `(u, v)` millimetres: point, line, circle, arc and
spline.

Two decisions worth knowing:

- **Arc endpoints are derived**, not stored. An arc is centre, radius and two
  angles, so its endpoints cannot drift off its own circle no matter what the
  solver does.
- **Rectangles, polygons and slots are not entity types.** They are built from
  lines and arcs plus automatic constraints, exactly as if drawn by hand. That
  keeps the solver's vocabulary small and every corner individually draggable and
  dimensionable.

Sketch planes are one of the three base planes with an offset, or a face of an
existing body. A face reference stores a geometric signature (centroid, normal,
area) so it can be found again after a rebuild, plus a frozen frame to fall back
on. SketchForge has no persistent topological naming; this is the pragmatic
compromise, and when the reference cannot be resolved it says so rather than
guessing.

Each base plane is right-handed with its normal pointing away from the model —
`+Z` front, `+Y` ground, `+X` right — so a positive extrude distance always grows
outward. On the ground plane this means sketch `v` runs opposite to world `z`;
the migration from freehand sketches accounts for that, so old geometry lands
exactly where it was.

### Constraints and dimensions

Geometric: coincident, point-on-entity, horizontal, vertical, parallel,
perpendicular, equal, tangent, concentric, midpoint, symmetric, fix.

Driving dimensions: distance, horizontal distance, vertical distance,
point-to-line distance, radius, diameter, angle. Each holds an expression, so a
dimension can read `bore / 2` and follow the parameter table.

### The solver — `lib/sketchSolver/`

Levenberg–Marquardt least squares over constraint residuals.

- Residuals are written as ordinary arithmetic over forward-mode automatic
  differentiation values, so the Jacobian is exact and cannot drift out of sync
  with the residual it belongs to. Hand-writing twenty analytic Jacobians is
  where solvers traditionally acquire their subtlest bugs.
- Solving uses dense Householder QR rather than the normal equations, whose
  condition number would be squared. Sketches are small; this is both fast enough
  and considerably more robust.
- Dimensionless residuals (a cross product of unit directions, an angle) are
  scaled into millimetres so one damping value is meaningful across the system.
- There is deliberately **no** stay-near-previous penalty term. LM damping
  already produces minimum-norm steps, which is what keeps unconstrained
  geometry still; an explicit penalty would bias the solution away from the
  dimension the user typed.

**Dragging** adds the cursor as a soft residual with a small weight. Constraints
stay exact to about 1e-5 mm while the free degrees of freedom follow the cursor
exactly, because nothing else in the system constrains them.

**Diagnostics.** Degrees of freedom are variables minus the rank of the
constraint Jacobian — the number shown in the status bar, and zero means fully
defined. Redundancy is found by accepting rows in creation order via modified
Gram–Schmidt: with `horizontal(a)`, `horizontal(b)` and `parallel(a, b)`, any one
of the three is implied by the other two, and users expect the one they just
added to be flagged rather than an arbitrary member of the set. A redundant
constraint that also cannot be satisfied is reported as conflicting.

### Profiles — `lib/sketchProfiles.ts`

Finds the closed regions you can select and extrude, reported as loops of **whole
entities** rather than polygons. That is what lets a circular hole become a real
cylindrical face instead of a many-sided prism. A loop's polyline is used only
for area, orientation and containment.

Entities are never split implicitly. Profiles are built by joining entities end
to end, and crossings are meant to be resolved explicitly with Trim and Extend.
Geometry that crosses without a shared endpoint is reported as an issue, and open
chains are listed, so you can see exactly what is not closed.

Nesting works on containment depth, so an island inside a hole is its own region
rather than part of the hole.

### Features — `lib/brepSketchFeatures.ts`

Regions become exact OpenCascade solids: extrude (one-sided, symmetric,
two-sided, with optional draft) and revolve, each in new-body, join, cut or
intersect mode.

Arcs are built with the three-point edge constructor rather than the angle-based
one. Angles are measured from whichever reference direction the kernel picks for
a circle's axis placement, which is not the sketch frame's X axis; three points
are fully determined by geometry.

Because the result is real B-Rep, a sketch body can be filleted, measured and
exported to STEP without losing its analytic geometry. Verified end to end
against the real kernel: a rectangle with a circular hole extrudes to six planar
faces plus exactly one cylindrical face, with the volume matching the analytic
answer.

## Running the tests

```bash
npm run test        # unit tests, including the solver and profile finder
npm run test:e2e    # feature builders against the real OpenCascade kernel
```

The solver's most valuable test compares every residual's analytic derivative
against a central finite difference. A wrong Jacobian still converges sometimes,
which makes that class of bug very hard to spot from behaviour alone.

## What is not built yet

- The sketch user interface: plane picker, drawing tools, constraint palette,
  dimension input, automatic constraint inference while drawing.
- The feature timeline that re-executes features when a dimension changes.
- Persistence of sketches and features in `.skf`.
- Sweep and loft, though the kernel supports both.
