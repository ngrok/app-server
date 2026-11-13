# Stay close to Vite

When `app-server start` does a job that `vite dev` also does, do it as Vite does: the same output, the same config options, and the same defaults. Differ only where the app server has its own job, and give the reason.

**Why:** An app developer already knows `vite dev`. When `start` prints, reads config, and acts as Vite does, the developer learns nothing new, and a Vite plugin or a Vite doc applies as it is.

**Applies to:** code, prose.

**Signs you missed it:**

- A dev-server message in a format that `vite dev` does not use, such as JSON where Vite prints text.
- A Vite option, such as `logLevel`, `server.host`, or `server.strictPort`, that `start` ignores or reads in a different way.
- A difference from `vite dev` that has no reason in a comment or in the README.

**In this repo:** `start` reads its port, host, `strictPort`, and `open` from Vite's `server` config, and it sets `server.resolvedUrls`. It reports a port in use and prints its URLs as `vite dev` does, through Vite's logger, so `logLevel` and `customLogger` apply. It does not bind Vite's CLI shortcuts, because Vite's `q` exits the process and skips the drain. It serves HTTP only, because the CLI makes its HTTP server before Vite reads the config. So it ignores `server.https`, with a warning.

**Enforced by:** review.
