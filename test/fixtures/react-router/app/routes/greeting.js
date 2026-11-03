import { greeting } from "@fixture/cjs-greeting";

// A server-rendered resource route that reads a file through an external CommonJS package.
export function loader() {
	return new Response(greeting());
}
