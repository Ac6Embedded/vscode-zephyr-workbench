const { build, context } = require("esbuild");
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

const webviewDebugManagerConfig = {
  ...baseConfig,
  target: "es2020",
  format: "esm",
  entryPoints: ["./src/webview/debugmanager.mts"],
  outfile: "./out/debugmanager.js",
};

const webviewWestManagerConfig = {
  ...baseConfig,
  target: "es2020",
  format: "esm",
  entryPoints: ["./src/webview/westmanager.mts"],
  outfile: "./out/westmanager.js",
};

const webviewHostToolsConfig = {
  ...baseConfig,
  target: "es2020",
  format: "esm",
  entryPoints: ["./src/webview/hosttools.mts"],
  outfile: "./out/hosttools.js",
};

const webviewEclairManagerConfig = {
  ...baseConfig,
  target: "es2020",
  format: "esm",
  entryPoints: ["./src/webview/eclairmanager/index.mts"],
  outfile: "./out/eclairmanager.js",
};

const buildConfigs = [
  extensionConfig,
  webviewCreateWestWorkspaceConfig,
  webviewImportSDKConfig,
  webviewCreateZephyrAppConfig,
  webviewDebugToolsConfig,
  webviewDebugManagerConfig,
  webviewWestManagerConfig,
  webviewHostToolsConfig,
  webviewEclairManagerConfig,
];

function formatError(error) {
  if (error?.location) {
    return `> ${error.location.file}:${error.location.line}:${error.location.column}: error: ${error.text}`;
  }

  if (error?.text) {
    return `> error: ${error.text}`;
  }

  return `> ${String(error)}`;
}

function reportErrors(errors = []) {
  errors.forEach(error => console.error(formatError(error)));
}

function createWatchPlugin(label, watchState) {
  return {
    name: `watch-logger:${label}`,
    setup(buildContext) {
      buildContext.onStart(() => {
        console.log(`[watch] ${label} build started`);
      });

      buildContext.onEnd(result => {
        if (result.errors.length > 0) {
          reportErrors(result.errors);
          return;
        }

        console.log(`[watch] ${label} build finished`);

        if (watchState && !watchState.initialBuildComplete) {
          watchState.pendingInitialBuilds.delete(label);

          if (watchState.pendingInitialBuilds.size === 0) {
            watchState.initialBuildComplete = true;
            console.log("[watch] initial build complete");
            console.log("[watch] watching for changes...");
          }
        }
      });
    },
  };
}

function withWatchPlugin(config, watchState) {
  return {
    ...config,
    plugins: [...(config.plugins ?? []), createWatchPlugin(config.outfile, watchState)],
  };
}

function createLegacyWatchConfig(label) {
  return {
    watch: {
      onRebuild(error, result) {
        console.log(`[watch] ${label} build started`);

        if (error) {
          reportErrors(error.errors ?? [error]);
          return;
        }

        if (result?.errors?.length > 0) {
          reportErrors(result.errors);
          return;
        }

        console.log(`[watch] ${label} build finished`);
      },
    },
  };
}

async function watchAll(configs) {
  if (typeof context !== "function") {
    await Promise.all(
      configs.map(async config => {
        console.log(`[watch] ${config.outfile} build started`);
        const result = await build({
          ...config,
          ...createLegacyWatchConfig(config.outfile),
        });

        if (result?.errors?.length > 0) {
          reportErrors(result.errors);
          return;
        }

        console.log(`[watch] ${config.outfile} build finished`);
      })
    );

    console.log("[watch] initial build complete");
    console.log("[watch] watching for changes...");
    return;
  }

  const watchState = {
    initialBuildComplete: false,
    pendingInitialBuilds: new Set(configs.map(config => config.outfile)),
  };

  const contexts = await Promise.all(configs.map(config => context(withWatchPlugin(config, watchState))));

  const disposeAll = async () => {
    await Promise.all(contexts.map(ctx => ctx.dispose()));
  };

  process.once("SIGINT", () => {
    disposeAll().finally(() => process.exit(0));
  });

  process.once("SIGTERM", () => {
    disposeAll().finally(() => process.exit(0));
  });

  await Promise.all(contexts.map(ctx => ctx.watch()));
}

function reportBuildFailure(error) {
  if (Array.isArray(error?.errors) && error.errors.length > 0) {
    reportErrors(error.errors);
    return;
  }

  if (typeof error?.stderr === "string" && error.stderr.length > 0) {
    process.stderr.write(error.stderr);
    return;
  }

  console.error(error?.message ?? String(error));
}

(async () => {
  const args = process.argv.slice(2);
  try {
    if (args.includes("--watch")) {
      await watchAll(buildConfigs);
    } else {
      await Promise.all(buildConfigs.map(config => build(config)));
      console.log("build complete");
    }
  } catch (err) {
    reportBuildFailure(err);
    process.exit(1);
  }
})();
