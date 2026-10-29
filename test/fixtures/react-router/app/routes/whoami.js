import { requestContext } from "@ngrok/app-server";
import { appServerContext } from "@ngrok/app-server/react-router";

// A server-rendered resource route that reads the request ID both ways.
export function loader({ context }) {
	return Response.json({
		fromContext: context.get(appServerContext).requestId,
		fromStorage: requestContext()?.requestId,
	});
}
