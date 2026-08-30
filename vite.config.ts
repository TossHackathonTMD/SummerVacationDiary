import aitDevtools from "@apps-in-toss/devtools/unplugin";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [aitDevtools.vite({ sdkVersion: "3" }), react()],
});
