import { useEffect, useState } from "react";

// A route that throws in a render after it hydrates. The error boundary of React Router catches
// the error, so no `error` event of `window` has it.
export default function Render() {
	const [broken, setBroken] = useState(false);
	useEffect(() => {
		setBroken(true);
	}, []);
	if (broken) {
		throw new Error("render failed");
	}
	return <h1>Render</h1>;
}
