import { clientErrorsReactRouter } from "@ngrok/app-server/client";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

const clientErrors = clientErrorsReactRouter();

hydrateRoot(document, <HydratedRouter onError={clientErrors.onError} />, clientErrors.rootOptions);
