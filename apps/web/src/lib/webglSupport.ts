// Can this browser draw 3D at all?
//
// Asked *before* the renderer is built rather than discovered by catching what
// it throws. A browser without WebGL is an ordinary situation — an old laptop, a
// remote desktop session, a driver on the browser's blocklist, hardware
// acceleration switched off by policy — and using an exception as the control
// flow for an ordinary situation fills the console with a stack trace that
// buries the one thing worth reading.
//
// The distinction between the two failures matters to the person reading the
// message. "This browser has no WebGL" is fixed in the browser's settings;
// "the context was lost" usually means the driver crashed and a reload helps.

export type WebglStatus = "ok" | "unavailable" | "creation-failed";

export type WebglReport = {
  status: WebglStatus;
  /** The browser's own words, when it offered any. Kept for the console. */
  detail?: string;
};

/**
 * Probes for a WebGL context on a throwaway canvas.
 *
 * The canvas is never attached to the document and its context is released
 * immediately: a browser allows only a small number of live WebGL contexts, and
 * a probe that quietly held one open would cost the viewport the context it was
 * probing for.
 */
export function detectWebglSupport(): WebglReport {
  if (typeof document === "undefined") {
    // Server rendering. Nothing is drawn there, and claiming "unavailable"
    // would flash the failure card before the client had a chance to try.
    return { status: "ok" };
  }

  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = document.createElement("canvas");
    const context =
      (canvas.getContext("webgl2") as WebGLRenderingContext | null) ??
      (canvas.getContext("webgl") as WebGLRenderingContext | null);

    if (!context) return { status: "unavailable" };

    // Release it straight away rather than waiting for the garbage collector,
    // which may take long enough that the renderer's own request is refused.
    const lose = context.getExtension("WEBGL_lose_context");
    lose?.loseContext();
    return { status: "ok" };
  } catch (error) {
    return { status: "unavailable", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    canvas?.remove();
  }
}
