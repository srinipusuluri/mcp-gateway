import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", ".wrangler/**", "tests/evaluations/results/**", "examples/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off", // tests and dynamic Salesforce records
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-eval": "error",
      "no-new-func": "error",
      "no-implied-eval": "error",
      eqeqeq: ["error", "smart"],
    },
  },
);
