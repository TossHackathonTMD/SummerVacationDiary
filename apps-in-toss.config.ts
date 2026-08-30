import { defineConfig } from "@apps-in-toss/web-framework/config";
import { BRAND_PRIMARY_COLOR } from "./src/constants/brand";

export default defineConfig({
  appName: "summer-vacation-diary",
  brand: {
    primaryColor: BRAND_PRIMARY_COLOR,
  },
  permissions: [],
  navigationBar: {
    withBackButton: true,
    withHomeButton: false,
    transparentBackground: false,
    theme: "light",
  },
  webView: {
    allowsBackForwardNavigationGestures: false,
  },
  webBundleDir: "dist",
});
