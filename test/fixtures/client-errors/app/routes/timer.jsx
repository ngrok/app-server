import { useEffect } from "react";

export default function Timer() {
	useEffect(() => {
		setTimeout(() => {
			throw new Error("timer failed");
		});
	}, []);
	return <h1>Timer</h1>;
}
