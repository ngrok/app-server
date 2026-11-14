# Name the arguments

A public function, option callback, or hook takes its arguments by name. It has one of two shapes:

- **One object with named fields**, such as `accessLog({ redactQuery })` and `withHeaderHook({ context, next, hook })`.
- **A subject, then one options object.** When the function acts on one obvious value, that value comes first. Each value that changes how the function works goes in one options object, last. Examples: `redirects(rules, { trailingSlash })`, `runtimeEnv(schema, { source })`, `eventStream(produce, { signal })`, and `files.open(path, { range })`.

There are two exceptions. A function with one obvious argument, such as `ready()` or `(error) => …`, takes it as it is. An API that copies a well-known API keeps the order of that API. Examples: `headers.set(name, value)`, `logger.info(message, attributes)`, a fetch handler's `(request, bindings)`, Hono's `(c, next)`, and `AsyncLocalStorage`'s `run(store, work)` in `RequestStore.run` and `withRequestContext(values, work)`.

**Why:** A name at the call site tells the reader what each value is. A caller takes only the fields that it needs, with no `_` placeholder for the others. Two values of one type cannot change places by mistake. A later release can add a field with no breaking change. The options object is last, so a call with no options drops it.

**Applies to:** code. Each export, each option of a plugin, each hook, and each type that an adapter or an app implements.

**Signs you missed it:**

- A callback with a `_` or `_level` placeholder for an argument that it does not use.
- Two parameters of one type, such as `(path: string, scriptSrc: string)`.
- Two positional values before the options, such as `fetchDev(request, bindings, devServer)`.
- An optional positional value, such as `open(path, range?)`.
- An options object before the subject, such as `eventStream(options, produce)`.
- A doc that says "the second argument is …".
- A release that adds a parameter to a callback at the end of its list.

**In this repo:**

- Each plugin factory takes an options object, such as `accessLog({ redactQuery })`.
- `LogSink.log({ level, message, attributes })`, and the `log` hooks `attributes(line)` and `error({ error, prefix, fields })`.
- `accessLog({ attributes: ({ context, sent }) => … })`, `prerendered({ rewrite, headers })` with `({ path, context })`, and `contentSecurityPolicy({ policy: ({ scriptSrc, context }) => … })`.
- The object costs one allocation for each call. On the hot path, measure it. See [keep the hot path lean](./keep-the-hot-path-lean.md).

**Enforced by:** review. `eslint/max-params` caps each function at three parameters, and `app-server/no-boolean-positional-param` rejects a boolean positional parameter.
