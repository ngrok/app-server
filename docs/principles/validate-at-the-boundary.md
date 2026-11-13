# Validate at the boundary

Parse untrusted input once, where it enters: a request header, the URL path, an environment value, a build file, or an app option. Inside the boundary, trust the parsed type. Check config at startup, so that a bad value never waits for the first request.

**Why:** A check at the entry gives one clear failure. Checks spread through the code repeat the work, miss a path, and let a bad value travel far before it fails. A config error at startup stops a deploy. The same error at request time stops traffic.

**Applies to:** code.

**Signs you missed it:**

- The same `typeof` or `== null` guard in several functions that receive one value.
- A cast on data from `JSON.parse`, `process.env`, or a request header.
- A config error that shows only on the first request.
- A header value that goes into a `Location`, a log line, or a file path with no check.
- An option that a plugin reads first in its middleware or in a header hook. A bad value is then a 500 for each request, while the health probes answer 200.

**In this repo:**

- `runtimeEnv` validates the environment at startup with a Standard Schema.
- `parsePort` rejects a bad `PORT`, and a throw in a plugin's `setup` stops startup.
- A plugin factory checks each option where the app calls it: `health()` its paths, `redirects()` each `from`, and `requestId()`, `buildId()`, `noindex()`, and `securityHeaders()` each header name and value. `createServer` checks the plugin list.
- `requestId()` reuses an incoming `X-Request-Id` only when it is valid.
- `trustForwardedProto` reads `X-Forwarded-Proto` only when the app sets it, and only for `http` or `https`.

**Enforced by:** review, and a test for each parser.
