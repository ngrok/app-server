---
"@ngrok/app-server": patch
---

Add one error sink for the client and the server.

`defaultPlugins({ errors: { sink, filter } })` gives each error of the app to one function of the app, such as one that sends it to an error tracker from the server. The sink gets the errors of the client code, and each error that ends a request with a 5xx in the server, with the request. An event has `side: "client"` or `side: "server"`, and a server event has the thrown error. With React Router, the sink also gets an error that the router catches in a loader, an action, or a render. `errors()` is also an export, for a plugin list of the app's own. The option is off by default. With `errors: true`, each client error is one `client error` line in the log.

For the client errors, the plugin adds an endpoint at `/_app/issues`. `clientErrorsScript()` from `@ngrok/app-server/client` gives an inline script for the `<head>` of the document. The script sends the errors of the page, also the error of a chunk that throws before the client entry runs. It keeps only an error that a script of the page's origin threw, sends each error once, and sends 10 reports at most for each page load. It sets no cookie and sends no user identifier.

`clientErrorsReactRouter()` and `clientErrorsTanStack()` give the script the errors that React and the router catch. Each gives the hooks for `hydrateRoot`, and the React Router one also gives the `onError` of `HydratedRouter`.

`appServer({ clientErrorsPath })` of the Vite plugin sets another path for the endpoint. The plugin gives it to each build and to the server, so the app sets it in one place.

See "Errors" in the README for the setup, the event type, a Sentry example, and how to write a sink and a filter.
