// Loading the OpenCascade kernel inside a worker.
//
// This was inline in `cadModifier.worker.ts` and is now shared, because a second
// worker needs exactly the same dance and duplicating it means two places to get
// the wasm path wrong.
//
// The kernel is fetched from `/occt/`, deliberately outside the Next bundler:
// the Emscripten glue loads its own `.wasm` relative to its own URL, which does
// not survive bundling. The URL is typed as `string` rather than a literal so
// TypeScript treats the dynamic import as runtime-resolved.

import { OcctKernel } from "occt-wasm";
import { CAD_MODIFIER_RUNTIME_BASE } from "@/lib/cadModifierRuntime";

type EmscriptenFactory = (options?: { locateFile?: (path: string) => string }) => Promise<unknown>;

let kernelPromise: Promise<OcctKernel> | null = null;

/**
 * The worker's kernel, loaded once and reused.
 *
 * A rejected attempt is dropped rather than cached, so a blip fetching 22 MB of
 * wasm does not poison every later request for the lifetime of the worker.
 */
export function loadWorkerKernel(): Promise<OcctKernel> {
  kernelPromise ??= (async () => {
    const moduleUrl: string = `${CAD_MODIFIER_RUNTIME_BASE}/occt-wasm.js`;
    const imported = (await import(/* webpackIgnore: true */ moduleUrl)) as { default: EmscriptenFactory };
    const module = await imported.default({
      locateFile: (path) => (path.endsWith(".wasm") ? `${CAD_MODIFIER_RUNTIME_BASE}/occt-wasm.wasm` : path),
    });
    const KernelConstructor = OcctKernel as unknown as new (rawModule: unknown) => OcctKernel;
    return new KernelConstructor(module);
  })().catch((error: unknown) => {
    kernelPromise = null;
    throw error;
  });
  return kernelPromise;
}

/** Forgets the cached kernel, so the next call reloads it after a wasm fault. */
export function resetWorkerKernel() {
  kernelPromise = null;
}
