# Name the arguments

A public function, option callback, or hook takes one object with named fields, not positional arguments. There are two exceptions. A function with one obvious argument, such as `ready()` or `(error) => …`, takes it as it is. An API that copies a well-known API keeps that API's order, such as `headers.set(name, value)`, `logger.info(message, attributes)`, a fetch handler's `(request, context)`, and Hono's `(c, next)`.

**Why:** A name at the call site tells the reader what each value is. A caller takes only the fields that it needs, with no `_` placeholder for the others. Two values of one type cannot change places by mistake. A later release can add a field with no breaking change.

**Applies to:** code. Each export, each option of a plugin, each hook, and each type that an adapter or an app implements.

**Signs you missed it:**

- A callback with a `_` or `_level` placeholder for an argument that it does not use.
- Two parameters of one type, such as `(path: string, scriptSrc: string)`.
- A doc that says "the second argument is …".
- A release that adds a parameter to a callback at the end of its list.

**In this repo:**

- Each plugin factory takes an options object, such as `accessLog({ redactQuery })`.
- `LogSink.log({ level, message, attributes })`, and the `log` hooks `attributes(line)` and `error({ error, prefix, fields })`.
- `accessLog({ attributes: ({ context, sent }) => … })`, `prerendered({ rewrite, headers })` with `({ path, context })`, and `contentSecurityPolicy({ policy: ({ scriptSrc, context }) => … })`.
- The object costs one allocation for each call. On the hot path, measure it. See [keep the hot path lean](./keep-the-hot-path-lean.md).

**Enforced by:** review. `eslint/max-params` caps each function at three parameters.
