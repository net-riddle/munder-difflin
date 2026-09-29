import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { readFileSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

// The runtime .cjs sidecars, from the one shared list. `createRequire` because
// this config is loaded as ESM, and the manifest is plain .cjs precisely so
// that node, the vite config and the build script can all read it.
const { MAIN_ASSETS } = createRequire(import.meta.url)('./tools/main-sidecars.cjs') as {
  MAIN_ASSETS: Array<[string, string]>;
};

// Single source of truth for the displayed app version: package.json.
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
const define = { __APP_VERSION__: JSON.stringify(pkg.version) };

// Anonymous product analytics (src/main/analytics.ts, contract in TELEMETRY.md).
// The PostHog project key is a PUBLIC write-only token, but it is still injected
// at BUILD time from the environment (release CI sets it from a repo secret)
// rather than committed: local dev builds and forks compile with '' and the
// whole analytics module no-ops for them. Main-process only.
const defineMain = {
  ...define,
  __POSTHOG_KEY__: JSON.stringify(process.env.POSTHOG_KEY ?? ''),
  __POSTHOG_HOST__: JSON.stringify(process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com')
};

// Copy raw .cjs main-process sidecars into out/main after the main bundle is
// written. electron-vite/rollup neither bundles nor copies require()'d .cjs
// sidecars, so without this the boot-time `require('./slack-trigger.cjs')` is
// missing from out/main — which crashed the packaged app (#66) AND `npm run
// dev` (#67). A writeBundle hook runs after the main build in BOTH dev and
// build, so the sidecar is emitted from a single place for every path.
//
// THE LIST IS NOT WRITTEN HERE. It lives in `tools/main-sidecars.cjs`, shared
// with `tools/copy-main-assets.cjs`, because this hook and that script are two
// ways of copying the same files and they had drifted apart: tts-budget.cjs was
// in the script but not here, and `npm run dev` does not run the script. So the
// app died at launch in dev only, which is the one path that skips the copy.
// A sidecar is now added in exactly one place.
function copyMainSidecars() {
  return {
    name: 'copy-main-cjs-sidecars',
    writeBundle() {
      for (const [fromRel, toRel] of MAIN_ASSETS) {
        const from = resolve(__dirname, fromRel);
        const to = resolve(__dirname, toRel);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
        const copied = statSync(to);
        if (!copied.isFile() || copied.size === 0) {
          throw new Error(`Failed to copy main-process sidecar: ${fromRel} -> ${toRel}`);
        }
      }
    }
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyMainSidecars()],
    define: defineMain,
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define,
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    define,
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@brand': resolve(__dirname, 'docs'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  }
});
