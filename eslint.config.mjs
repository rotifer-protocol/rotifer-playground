import tseslint from "typescript-eslint";

const booleanPrefixes = ["is", "has", "should", "can", "did", "will", "does"];

export default tseslint.config(
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: "variable",
          types: ["boolean"],
          format: ["PascalCase"],
          prefix: booleanPrefixes,
          leadingUnderscore: "allow",
        },
        {
          selector: "parameter",
          types: ["boolean"],
          format: ["PascalCase"],
          prefix: booleanPrefixes,
        },
      ],
    },
  },
  {
    ignores: ["dist/", "node_modules/", "tests/", "scripts/", "crates/"],
  },
);
