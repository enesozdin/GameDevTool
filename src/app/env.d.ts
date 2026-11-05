// Build-time constants injected by build/build.ts (esbuild `define`).
declare const __APP_VERSION__: string;

// CSS is bundled by esbuild and inlined into the HTML file.
declare module "*.css" {}

// Source of the Monte Carlo worker (src/app/workers/monte-carlo.worker.ts), bundled first.
declare const __MONTE_CARLO_WORKER__: string;
