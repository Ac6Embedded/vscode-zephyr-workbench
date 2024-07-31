const { build } = require("esbuild");
const { copy } = require("esbuild-plugin-copy");

const baseConfig = {
  bundle: true,
  minify: process.env.NODE_ENV === "production",
  sourcemap: process.env.NODE_ENV !== "production",
};

const extensionConfig = {
  ...baseConfig,
  platform: "node",
  mainFields: ["module", "main"],
  format: "cjs",
  entryPoints: ["./src/extension.ts"],
  outfile: "./out/extension.js",
  external: ["vscode", "7zip-bin"],
  plugins: [
    copy({
      resolveFrom: "cwd",
      assets: {
        from: ["./node_modules/7zip-bin/win/**/*"],
        to: ["./out/win"],
      },
    }),
  ],
};

const watchConfig = {
  watch: {
    onRebuild(error, result) {
      console.log("[watch] build started");
      if (error) {
        error.errors.forEach(error =>
          console.error(`> ${error.location.file}:${error.location.line}:${error.location.column}: error: ${error.text}`)
        );
      } else {
        console.log("[watch] build finished");
      }
    },
  },
};

const webviewCreateWestWorkspaceConfig = {
  ...baseConfig,
  target: "es2020",
  format: "esm",
  entryPoints: ["./src/webview/createwestworkspace.mts"],
  outfile: "./out/createwestworkspace.js",
  plugins: [
    copy({
      resolveFrom: "cwd",
      assets: {
        from: ["./src/webview/*.css", "./src/webview/*.ttf"],
        to: ["./out"],
      },
    }),
  ],
};

const webviewImportSDKConfig = {
  ...baseConfig,
  target: "es2020",
  format: "esm",
  entryPoints: ["./src/webview/importsdk.mts"],
  outfile: "./out/importsdk.js",
};

const webviewCreateZephyrAppConfig = {
  ...baseConfig,
  target: "es2020",
  format: "esm",
  entryPoints: ["./src/webview/createzephyrapp.mts"],
  outfile: "./out/createzephyrapp.js",
};

const webviewDebugToolsConfig = {
  ...baseConfig,
  target: "es2020",
  format: "esm",
  entryPoints: ["./src/webview/debugtools.mts"],
  outfile: "./out/debugtools.js",
};

const webviewNewModuleConfig = {
  ...baseConfig,
  target: "es2020",
  format: "esm",
  entryPoints: ["./src/webview/newmodule.mts"],
  outfile: "./out/newmodule.js",
};

(async () => {
  const args = process.argv.slice(2);
  try {
    if (args.includes("--watch")) {
      // Build and watch extension and webview code
      console.log("[watch] build started");
      await build({
        ...extensionConfig,
        ...watchConfig,
      });
      await build({
        ...webviewCreateWestWorkspaceConfig,
        ...webviewImportSDKConfig,
        ...webviewCreateZephyrAppConfig,
        ...webviewNewModuleConfig,
        ...webviewDebugToolsConfig,
        ...watchConfig,
      });
      console.log("[watch] build finished");
    } else {
      // Build extension and webview code
      await build(extensionConfig);
      await build(webviewCreateWestWorkspaceConfig);
      await build(webviewImportSDKConfig);
      await build(webviewCreateZephyrAppConfig);
      await build(webviewNewModuleConfig);
      await build(webviewDebugToolsConfig);
      console.log("build complete");
    }
  } catch (err) {
    process.stderr.write(err.stderr);
    process.exit(1);
  }
})();