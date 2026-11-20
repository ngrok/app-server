---
"@ngrok/app-server": patch
---

Add client error reports with a sink that the app supplies.

`defaultPlugins({ clientErrors: true })` adds an endpoint at `/_app/issues` that takes the errors of the app's client code. With no other option, each error is one `client error` line in the log. `clientErrors: { sink, filter }` gives each error to the app's own function, such as one that sends it to an error tracker. `clientErrors()` is also an export, for a plugin list of the app's own. The option is off by default.

`clientErrorsReactRouter()` and `clientErrorsTanStack()` from `@ngrok/app-server/client` send the errors. Each gives the hooks for `hydrateRoot`, and the React Router one also gives the `onError` of `HydratedRouter`. They keep only an error that a script of the page's origin threw, send each error once, and send 10 reports at most for each page load. They set no cookie and send no user identifier. `clientErrorsScript()` gives an inline script that keeps the errors that come before the entry chunk runs. If the entry chunk does not run, the script sends them when the page hides.

`appServer({ clientErrorsPath })` of the Vite plugin sets another path for the endpoint. The plugin gives it to the client build and to the server, so the app sets it in one place.

See "Client errors" in the README for the setup, the event type, and how to write a sink and a filter.
