// Test settings, kept separate from the app's Vite config so tests run fast and simple
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});