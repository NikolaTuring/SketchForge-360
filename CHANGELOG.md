# Changelog

All notable changes to SketchForge are recorded here. Dates are the day the work
landed on the development branch.

## Unreleased

### Added

- **Parametric sketcher.** Sketch tab → *Parametric sketch*. Pick a plane, draw
  with lines, rectangles, circles, arcs, polygons, slots and points, and edit
  with trim, extend, offset, 2D fillet, mirror and rectangular or circular
  patterns. Relations: coincident, horizontal, vertical, parallel, perpendicular,
  equal, tangent and concentric. Dimensions accept expressions with units and
  arithmetic. The solver reports degrees of freedom and flags conflicts as you
  work.
- **Exact sketch bodies.** Profiles are extruded through OpenCascade in a
  worker, so a sketch body keeps analytic faces and exports to STEP as the
  geometry it was built from rather than as a tessellation.
- **Editable sketch bodies.** A body stores the sketch that built it and can be
  reopened and rebuilt at a different size, keeping its identity in the tree.
- **Mesh surface recognition.** Mesh tab → *Recognise surfaces*. Reports the
  planes, cylinders, cones and spheres found in an imported STL, how much of the
  surface they account for, and whether the mesh is closed enough to become a
  solid at all. Tolerances are adjustable.
- **Model browser.** A tree of origin planes and bodies, with per-body
  visibility, lock and rename, group expansion, two-way selection, and a dock
  that remembers its width.
- **Status bar.** Selection, extents, snap step and — permanently — the length
  unit every number in the editor is in.
- **Fit to selection.** `F` frames what is selected, or the whole model when
  nothing is, without changing the viewing direction. `Home` remains the reset.
- **Context menu.** Right-click offers the commands that apply to the current
  selection, from the same registry as the ribbon and the search.
- **Command search.** Ctrl+K reaches every command by name, diacritic-tolerant,
  in either language.
- **Bilingual interface.** German and English with a switcher; the choice is
  remembered.
- **Five-tab ribbon.** Solid, Sketch, Mesh, Inspect and Utilities, with import,
  export, settings, search and the language switch reachable from all of them.
- **Browser test suite.** Playwright coverage of the editor, which had none.

### Changed

- The editor shell is a CSS grid rather than stacked fixed layers, so panels can
  take real space instead of overlapping the model.
- The orientation cube moved to the top right, where CAD applications put it; the
  camera controls took the freed corner.
- The notice line moved from a toast floating over the model into the status bar.
- `.skf` is at format version 2 for the stored sketch. Version 1 files open
  unchanged and version 2 files still open in older builds.

### Fixed

- A locked body could be deleted. Every other operation — move, hide, align,
  mirror — skips locked bodies; delete did not.
- Escape needed two presses to close the fillet and chamfer tool.
- The command search shortcut hint showed the Apple glyph on every platform,
  naming a key that does nothing on Windows and Linux.
- Face normals read from the CAD kernel pointed inward, which would have made a
  sketch drawn on a face extrude into the body it was drawn on.
- The kernel's indexed tessellation was read as a triangle soup, reporting a
  closed solid as an open shell.
- The STEP text for a sketch body was emitted in world coordinates while its mesh
  was stored locally, so exported files landed offset by the body's placement.
