import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectRegister: false,
      injectManifest: { globPatterns: ["**/*.{js,css,html,svg,png,woff2}"], globIgnores: ["**/noto-emoji-*", "**/twemoji-*"], maximumFileSizeToCacheInBytes: 4 * 1024 * 1024 },
      manifest: {
        name: "Constella",
        short_name: "Constella",
        description: "你的 agent 星座：手机上管理一群 24 小时干活的 agent",
        lang: "zh-CN",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "any",
        background_color: "#1c1a23",
        // Constella shows up in the system share sheet: links, text and files go to an agent's new conversation.
        share_target: {
          action: "/share",
          method: "POST",
          enctype: "multipart/form-data",
          params: { title: "title", text: "text", url: "url", files: [{ name: "files", accept: ["*/*"] }] },
        },
        theme_color: "#1c1a23",
        icons: [
          { src: "/icon-192.png?v=2", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png?v=2", sizes: "512x512", type: "image/png" },
          { src: "/icon-maskable-512.png?v=2", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
  build: { target: "esnext", chunkSizeWarningLimit: 1200 },
  server: { proxy: { "/api": { target: "http://127.0.0.1:8780", ws: true } } },
});
