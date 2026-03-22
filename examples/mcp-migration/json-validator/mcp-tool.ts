/**
 * BEFORE: MCP Tool — JSON Validator
 *
 * A typical MCP Tool that validates JSON against a schema.
 * This file shows the original MCP Tool format before migration.
 */

import { z } from "zod";
import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true });

export const jsonValidatorTool = {
  name: "json_validator",
  description: "Validate a JSON string against a JSON Schema",
  inputSchema: z.object({
    json: z.string().describe("JSON string to validate"),
    schema: z.string().describe("JSON Schema to validate against"),
  }),
  handler: async ({ json, schema }: { json: string; schema: string }) => {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(json);
    } catch (e) {
      return {
        valid: false,
        errors: [{ message: `Invalid JSON: ${(e as Error).message}`, path: "" }],
        parsedSuccessfully: false,
      };
    }

    let parsedSchema: object;
    try {
      parsedSchema = JSON.parse(schema);
    } catch (e) {
      return {
        valid: false,
        errors: [{ message: `Invalid schema: ${(e as Error).message}`, path: "" }],
        parsedSuccessfully: true,
      };
    }

    const validate = ajv.compile(parsedSchema);
    const valid = validate(parsedJson);

    return {
      valid,
      errors: valid
        ? []
        : (validate.errors || []).map((e) => ({
            message: e.message || "unknown error",
            path: e.instancePath || "",
          })),
      parsedSuccessfully: true,
    };
  },
};
