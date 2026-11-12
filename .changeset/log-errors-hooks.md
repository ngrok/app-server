---
"@ngrok/app-server": minor
---

Logging: one error format, a logger outside a request, and hooks to change each line.

- An attribute whose value is an `Error` becomes dotted fields under its name: `kind`, `message`, `stack`, each own field, such as `code`, the `cause` chain as `<name>.cause.*`, and the members of an `AggregateError` as `<name>.errors`. The server's own error lines, such as `unhandled error`, now also write `error.cause.*` and the error's own fields.
- `jsonSink()` and `textSink()` write a bigint as a string, such as `"1n"`, and a cycle as `"[Circular]"`. A log call no longer throws for its attributes.
- `jsonSink()` writes each line about 40% faster: it no longer copies the attributes into a new object.
- `logger()` gives the logger of the request that runs. Outside a request, it writes to the sink and hooks of the last `createServer` call, else to `jsonSink()`. The default logger of `appServerContext` outside a request now writes there too.
- The `log` option of `createServer` takes two hooks: `attributes` changes the attributes of each line, and `error` gets the default fields of each error and gives the fields to write.
- Breaking: the request fields of a request's log line (`http.request_id`, `http.method`, `http.url_details.path`, and `logAttributes`) now win over a field of the same name that the caller gives. Before, the caller's field replaced them. To write your own value, use another name, or change it in the `log.attributes` hook.
- Breaking: each callback of a public option and the `LogSink.log` method now take one object with named fields, not positional arguments. Change each one as follows:

  ```ts
  // Before
  logger: { log: (level, message, attributes) => … }
  accessLog({ attributes: (c, sent) => … })
  prerendered({ headers: (path, c) => …, rewrite: (path, c) => … })
  prerendered({ markdownTwins: { twinOf: (path, c) => … } })
  contentSecurityPolicy({ policy: (scriptSrc, c) => … })

  // After
  logger: { log: ({ level, message, attributes }) => … }
  accessLog({ attributes: ({ context, sent }) => … })
  prerendered({ headers: ({ path, context }) => …, rewrite: ({ path, context }) => … })
  prerendered({ markdownTwins: { twinOf: ({ path, context }) => … } })
  contentSecurityPolicy({ policy: ({ scriptSrc, context }) => … })
  ```
