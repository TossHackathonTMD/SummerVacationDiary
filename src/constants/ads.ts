// Ad unit IDs for the Apps in Toss ad SDK.
//
// Which set a bundle carries is decided at build time, not guessed at runtime.
// There is no API that reports "this is a pre-release QR test" — `env
// .getDeploymentId()` returns an id in both cases — and both ways of guessing
// wrong are expensive: live units inside a test build can be treated as a
// policy violation, and test units inside the release earn nothing while
// looking completely normal. An explicit flag cannot be wrong about which
// build it is.
//
// The default is deliberately the live set, so a forgotten flag ships a
// working release rather than a silently unpaid one.
//
//   QR test build : npm run build:test   (VITE_USE_TEST_ADS=true)
//   Release build : npm run build
//
// Verify a release bundle with:
//   grep -c "ait-ad-test" dist/assets/index-*.js   # must be 0
const USE_TEST_ADS = import.meta.env.VITE_USE_TEST_ADS === "true";

// Fixed strings published in the Toss ad docs — shared by every developer, not
// issued per app, and earning nothing. Safe to commit; they are not secrets.
// Ads of any kind only render inside the real Toss app: neither set draws
// anything in a browser or in the sandbox, which excludes in-app ads by design.
const TEST_REWARDED_AD_GROUP_ID = "ait-ad-test-rewarded-id";
const TEST_BANNER_AD_GROUP_ID = "ait-ad-test-banner-id";

// Issued by the Apps in Toss developer console; revenue accrues to these.
const LIVE_REWARDED_AD_GROUP_ID = "ait.v2.live.b7f333e3c6324cc5";
const LIVE_BANNER_AD_GROUP_ID = "ait.v2.live.f777b418dd604163";

/** Full-screen rewarded ad — grants one extra AI diary run per day. */
export const REWARDED_AD_GROUP_ID = USE_TEST_ADS
  ? TEST_REWARDED_AD_GROUP_ID
  : LIVE_REWARDED_AD_GROUP_ID;

/** Inline banner shown on the preview and calendar views. */
export const BANNER_AD_GROUP_ID = USE_TEST_ADS
  ? TEST_BANNER_AD_GROUP_ID
  : LIVE_BANNER_AD_GROUP_ID;
