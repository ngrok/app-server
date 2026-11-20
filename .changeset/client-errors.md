---
"@ngrok/app-server": patch
---

Add client error reports with a sink that the app supplies.

`defaultPlugins({ clientErrors: true })` adds an endpoint at `/_app/issues` that takes the errors of the app's client code. With no other option, each error is one `client error` line in the log. `clientErrors: { sink, filter }` gives each error to the app's own function, such as one that sends it to an error tracker. `clientErrors()` is also an export, for a plugin list of the app's own. The option is off by default.

`clientErrorsScript()` from `@ngrok/app-server/client` gives an inline script for the `<head>` of the document. The script sends the errors of the page, also the error of a chunk that throws before the client entry runs. It keeps only an error that a script of the page's origin threw, sends each error once, and sends 10 reports at most for each page load. It sets no cookie and sends no user identifier.

`clientErrorsReactRouter()` and `clientErrorsTanStack()` give the script the errors that React and the router catch. Each gives the hooks for `hydrateRoot`, and the React Router one also gives the `onError` of `HydratedRouter`.

`appServer({ clientErrorsPath })` of the Vite plugin sets another path for the endpoint. The plugin gives it to each build and to the server, so the app sets it in one place.

See "Client errors" in the README for the setup, the event type, and how to write a sink and a filter.
