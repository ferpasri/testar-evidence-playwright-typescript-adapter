import { defineConfig } from "playwright/test";

export default defineConfig({
    testDir: ".", testMatch: "runner.spec.ts", outputDir: "../target/runner-results",
    use: {headless: true}, workers: 1,
});
