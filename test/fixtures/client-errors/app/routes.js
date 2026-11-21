import { index, route } from "@react-router/dev/routes";

export default [
	index("routes/home.jsx"),
	route("chunk", "routes/chunk.jsx"),
	route("render/:id", "routes/render.jsx"),
	route("timer", "routes/timer.jsx"),
	route("rejection", "routes/rejection.jsx"),
];
