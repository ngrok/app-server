import { clientErrorsScript } from "@ngrok/app-server/client";
import { Outlet, Scripts } from "react-router";

export default function Root() {
	return (
		<html lang="en">
			<head>
				<script dangerouslySetInnerHTML={{ __html: clientErrorsScript() }} />
			</head>
			<body>
				<Outlet />
				<Scripts />
			</body>
		</html>
	);
}
