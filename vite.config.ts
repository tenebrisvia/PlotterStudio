import { resolve } from "node:path";
import { defineConfig } from "vite";
import { wgslVitePlugin } from "vgpu/client";

export default defineConfig({
  base: "./",
  plugins: [wgslVitePlugin()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        "hello-world-2d": resolve(__dirname, "examples/hello-world-2d.html"),
        "hello-world-3d": resolve(__dirname, "examples/hello-world-3d.html"),
        "hello-world-custom-hatch": resolve(__dirname, "examples/hello-world-custom-hatch.html"),
      },
    },
  },
});
