import { index, route } from "@react-router/dev/routes";

export default [
	index("routes/home.jsx"),
	route("hello.txt", "routes/hello.js"),
	route("whoami", "routes/whoami.js"),
];
