# Changelog

## Unreleased

Foundations for a parametric CAD core. All of the following is library code with
unit and end-to-end test coverage; none of it is wired into the editor yet, and
no existing behaviour changes.

- Named parameters with an expression language (units, functions, references,
  cycle detection) that never evaluates untrusted input as JavaScript.
- Parametric sketch data model with analytic entities, geometric constraints and
  driving dimensions, plus a migration from the existing freehand sketches.
- Constraint solver: Levenberg-Marquardt over automatically differentiated
  residuals, dense Householder QR, interactive dragging, degrees-of-freedom
  reporting and redundant/conflicting constraint detection.
- Closed-region detection that reports profiles as loops of whole entities, so
  analytic geometry survives into the feature builders.
- Exact extrude and revolve through OpenCascade, in new-body, join, cut and
  intersect modes. Fixes the sketch plane normals, which pointed into the model
  rather than out of it, and the slot builder, whose end caps bulged inwards.
- Mesh surface recognition: plane, cylinder, cone and sphere fitting from an
  imported triangle mesh, with direction clustering, dimension rounding and
  coaxiality enforcement, and honest coverage reporting.
- New documentation: `docs/SKETCHING.md`, `docs/MESH_CONVERSION.md`,
  `docs/LEGAL.md`.

## 0.1.0

- Initial open-source alpha.
- Browser-based 3D workspace with primitive shape editing.
- STL import and STL/OBJ export.
- Grouping and hole subtraction workflows.
- Local project dashboard with generated thumbnails.
