---
"@ngrok/app-server": patch
---

Make the README agree with the code. No behavior changes.

- The React Router example for a markdown twin gives `twinOf` the `{ path }` argument of 0.4.0. The old example had a type error. In JavaScript, it ran with no error and sent HTML for a markdown request.
- The requirement is Node.js 26, not Node.js 26+, as `engines.node` is `^26.0.0`.
- "The pipeline" gives the `name` of each default plugin, for a filter of `defaultPlugins()`, and the `ContextVariableMap` declaration that types an app's own context value.
- "Logs" lists each line that the server writes, with its level and its attributes.
- "Commands" says that a `port` or a `host` in `tcp()` wins over `--port`, `PORT`, and `HOST`.
- "Adapters" names `createEntry`, `runtimeOptions`, the `name` of `FrameworkRuntime`, the rules of `output`, and the measured cost of the file list of `snapshot()`.
- "Environment" names `env.values`, and "Long-lived responses" names the options of `eventStream()`.
