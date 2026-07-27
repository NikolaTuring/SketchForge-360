"use client";

import { useTranslation } from "@/lib/i18n";
import type { WebglStatus } from "@/lib/webglSupport";

/**
 * Shown in place of the 3D viewport when the browser cannot draw it.
 *
 * The rest of the editor stays alive behind this: the ribbon, the model
 * browser, the status bar and — the one that matters — the sketcher, which is
 * plain SVG and has no reason to fail because 3D does. Someone on a locked-down
 * school laptop can still draw and dimension a profile.
 *
 * There is no "try again" button. The state does not change until the browser
 * is restarted with different settings, and a button that reliably does nothing
 * costs more trust than it saves clicks.
 */
export function WebglUnavailable({ status }: { status: WebglStatus }) {
  const { t } = useTranslation();

  // The two failures have different answers. A lost context means the driver
  // gave up and a reload usually brings it back; no context at all is a setting.
  const lost = status === "creation-failed";

  return (
    <div className="webgl-unavailable" data-testid="webgl-unavailable" role="status">
      <div className="webgl-unavailable-card">
        <h2>{t("webgl.title")}</h2>
        <p className="webgl-lead">{lost ? t("webgl.leadLost") : t("webgl.lead")}</p>

        <ol>
          <li>{t("webgl.stepBrowser")}</li>
          <li>{t("webgl.stepAcceleration")}</li>
          <li>{t("webgl.stepDriver")}</li>
        </ol>

        <p className="webgl-diagnose">{t("webgl.diagnose")}</p>

        {/* Said plainly, because it is the useful part: the work is not blocked,
            only the 3D view is. */}
        <p className="webgl-still-works">{t("webgl.sketchStillWorks")}</p>
      </div>
    </div>
  );
}
