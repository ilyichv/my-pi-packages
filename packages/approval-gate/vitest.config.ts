import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "approval-gate",
		include: ["test/**/*.test.ts"],
	},
});
