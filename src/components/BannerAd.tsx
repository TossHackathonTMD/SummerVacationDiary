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
 */

import { TossAds } from "@apps-in-toss/web-framework";
import { useEffect, useRef, useState } from "react";

import { BANNER_AD_GROUP_ID } from "../constants/ads";

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

export function BannerAd() {
  const slotRef = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    // Guards the async gap: the view can unmount while initialize() is still
    // pending, and attaching a banner to a detached node leaks the slot.
    let cancelled = false;
    let slot: { destroy: () => void } | null = null;

    void ensureAdsInitialized().then((ready) => {
      const target = slotRef.current;
      if (!ready || cancelled || target === null) {
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
                setRendered(true);
              }
            },
            onAdFailedToRender: () => {
              if (!cancelled) {
                setRendered(false);
              }
            },
            onNoFill: () => {
              if (!cancelled) {
                setRendered(false);
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

  return (
    <div className={`banner-ad${rendered ? " is-rendered" : ""}`} aria-label="광고">
      <div ref={slotRef} className="banner-ad-slot" />
    </div>
  );
}
