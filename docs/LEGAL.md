# Legal notes on the parametric CAD work

SketchForge is MIT licensed and depends only on open-source components. This
note records the boundaries the parametric sketcher and the mesh conversion work
were built inside, so contributors know where the lines are.

## Dependencies

Everything the CAD core uses is permissively licensed:

| Component | Purpose | Licence |
| --- | --- | --- |
| `occt-wasm` | OpenCascade geometry kernel, compiled to WebAssembly | MIT OR Apache-2.0 |
| `brepjs` | Higher-level B-Rep façade over the kernel | Apache-2.0 |
| `manifold-3d` | Robust mesh CSG | Apache-2.0 |
| `three` | Rendering | MIT |

No new dependency was added for the constraint solver, the profile finder or the
mesh recognition pipeline. The dense linear algebra they need
(`lib/sketchSolver/linalg.ts`, `lib/meshToBrep/surfaceFit.ts`) is written out in
full rather than pulled in.

## What this project deliberately does not do

- **No proprietary CAD file formats.** `.f3d` and `.f3z` are undocumented
  container formats belonging to their vendor. SketchForge does not read or
  write them and there are no plans to. Interchange goes through STEP, STL, OBJ,
  SVG and the project's own `.skf`.
- **No third-party code, icons, fonts, artwork or branding.** Every icon is
  either from `lucide-react` or drawn as an SVG in this repository.
- **No product names of commercial CAD systems** appear in the user interface,
  in source code, in comments, in commit messages or in this documentation.

## On terminology and layout

Words like *sketch*, *constraint*, *coincident*, *tangent*, *extrude*,
*revolve*, *timeline* and *parameter* are the ordinary vocabulary of solid
modelling and are used across the whole industry, including in long-standing
open-source CAD. They are not any one vendor's property.

The same applies to interface arrangement. A toolbar of grouped commands along
the top, a model tree at one side, a feature history along the bottom, an
orientation cube in a corner: these are functional conventions shared by
essentially every parametric CAD application, open-source ones included.
Adopting that arrangement is not copying a product — copying its icon artwork,
its exact colours or its name would be, and this project does neither.

## Clean-room stance

The geometry in this repository was derived from published mathematics —
Levenberg–Marquardt least squares, Householder QR, Jacobi eigenvalue iteration,
Gauss-map surface recognition — and from the documented public APIs of the
open-source libraries listed above. No commercial CAD system was decompiled,
disassembled, or otherwise inspected beyond using it as an end user.
