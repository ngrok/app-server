// The React Router app for `test/browser.ts`. It builds with the built package, as
// `fixtures/react-router` does. Why another path: the check then proves that the inline script,
// the client build, and the endpoint use the one path of the Vite plugin.
import { reactRouter } from "@react-router/dev/vite";
import { appServer } from "../../../dist/vite.js";

export default {
	logLevel: "warn",
	plugins: [reactRouter(), appServer({ clientErrorsPath: "/_x" })],
};
