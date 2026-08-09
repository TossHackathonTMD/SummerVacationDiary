/**
 * Inline banner ad for the preview and calendar views.
 *
 * Mounted once by App, directly under the header, rather than by each view —
 * see the comment at that call site for why the position has to be decided
 * there.
 *
 * Two things shape this component. First, `TossAds.initialize` is a one-time
 * global setup rather than something each banner does, so the promise below is
 * module-level and shared, and survives a remount. Second, the container
 * renders at zero height until the SDK confirms an ad was actually drawn: in a
 * plain browser (and whenever the network returns no fill) there is no ad, and
 * reserving a 96px gap for it would leave a permanent hole above the diary.
 * `VITE_AD_PLACEHOLDER=true` opts out of that collapse so the space can be
 * laid out during development.
 */

import { TossAds } from "@apps-in-toss/web-framework";
import { useEffect, useRef, useState } from "react";

import { BANNER_AD_GROUP_ID } from "../constants/ads";

/**
 * Renders a stand-in block wherever a real banner cannot load. Real ads only
 * ever appear inside the production Toss app — not in a browser, and not in
 * the sandbox, which excludes in-app ads by design — so without this the space
 * around a banner could not be laid out until after a console deploy.
 *
 * Driven by an env flag rather than `import.meta.env.DEV` so the placeholder
 * can be switched off while still running the dev server, and so it can never
 * follow a production bundle: `ait build` runs without the flag set.
 */
const SHOW_AD_PLACEHOLDER = import.meta.env.VITE_AD_PLACEHOLDER === "true";

/**
 * Resolves to whether the ads SDK is usable. Cached forever after the first
 * call: initialisation is global, idempotent from our side, and a failure is
 * not worth retrying on every navigation.
 */
let initialization: Promise<boolean> | null = null;

function ensureAdsInitialized(): Promise<boolean> {
  initialization ??= new Promise<boolean>((resolve) => {
    try {
      if (!TossAds.initialize.isSupported()) {
        resolve(false);
        return;
      }
      TossAds.initialize({
        callbacks: {
          onInitialized: () => resolve(true),
          onInitializationFailed: () => resolve(false),
        },
      });
    } catch {
      resolve(false);
    }
  });
  return initialization;
}

/** `ad` and `placeholder` both occupy space; only `ad` involves the SDK. */
type SlotState = "hidden" | "ad" | "placeholder";

/** Where the slot rests whenever no real ad is on screen. */
const IDLE_STATE: SlotState = SHOW_AD_PLACEHOLDER ? "placeholder" : "hidden";

export function BannerAd() {
  const slotRef = useRef<HTMLDivElement>(null);
  // Starts at the idle state instead of waiting on the SDK. The sandbox ships
  // the ads bridge but serves no ads, and in that case neither the failure
  // callbacks nor the "unsupported" branch is guaranteed to fire — a
  // placeholder gated behind either one would stay invisible there. Showing it
  // first and letting a real onAdRendered replace it is the only arrangement
  // that does not depend on which signal the runtime happens to send.
  const [state, setState] = useState<SlotState>(IDLE_STATE);

  useEffect(() => {
    // Guards the async gap: the view can unmount while initialize() is still
    // pending, and attaching a banner to a detached node leaks the slot.
    let cancelled = false;
    let slot: { destroy: () => void } | null = null;

    void ensureAdsInitialized().then((ready) => {
      const target = slotRef.current;
      if (cancelled || target === null) {
        return;
      }
      if (!ready) {
        // Plain browsers land here: no Toss bridge, so nothing to attach to.
        return;
      }
      try {
        slot = TossAds.attachBanner(BANNER_AD_GROUP_ID, target, {
          // This diary has no dark mode — every surface it draws is light
          // paper under a light sky. `auto` would let the SDK repaint the ad
          // near-black whenever the Toss app itself is dark, which is the one
          // outcome that actually clashes. Pinning it light is an option the
          // SDK offers, not a restyle of the ad, so it stays within the ad
          // guidelines. `expanded` keeps the ad at the same inline inset as
          // every other card; `card` would add its own 10px and round the
          // corners symmetrically, which this app's hand-drawn frames do not.
          theme: "light",
          tone: "blackAndWhite",
          variant: "expanded",
          callbacks: {
            // Revealed here rather than on attach, so a no-fill response leaves
            // the layout exactly as it was.
            onAdRendered: () => {
              if (!cancelled) {
                setState("ad");
              }
            },
            onAdFailedToRender: () => {
              if (!cancelled) {
                setState(IDLE_STATE);
              }
            },
            // Not a bug on its own: Toss withholds delivery when eCPM falls
            // below its internal threshold, so an approved live unit can
            // legitimately return no fill.
            onNoFill: () => {
              if (!cancelled) {
                setState(IDLE_STATE);
              }
            },
          },
        });
      } catch {
        // A banner that cannot attach is not worth surfacing — the diary works
        // the same without it.
      }
    });

    return () => {
      cancelled = true;
      try {
        slot?.destroy();
      } catch {
        // Best effort; the view is going away regardless.
      }
    };
  }, []);

  // `is-rendered` carries the spacing both occupied states need; `is-placeholder`
  // additionally hides the empty slot, whose frame would otherwise draw as a
  // stray 2px strip above the stand-in.
  const className = [
    "banner-ad",
    state === "hidden" ? null : "is-rendered",
    state === "placeholder" ? "is-placeholder" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={className} aria-label="광고">
      {/* The SDK requires this container's interior to stay empty, so the
          placeholder is a sibling rather than a child. */}
      <div ref={slotRef} className="banner-ad-slot" />
      {state === "placeholder" ? (
        <div className="banner-ad-placeholder">광고 영역 · 96px</div>
      ) : null}
    </div>
  );
}
