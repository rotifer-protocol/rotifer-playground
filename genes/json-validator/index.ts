interface ValidatorInput {
  data: unknown;
  schema: Record<string, unknown>;
  strict?: boolean;
}

interface ValidationError {
  path: string;
  message: string;
  keyword: string;
}

interface ValidatorOutput {
  valid: boolean;
  errors: ValidationError[];
  errorCount: number;
}

function validate(
  data: unknown,
  schema: Record<string, unknown>,
  path: string,
  strict: boolean,
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (schema.type) {
    const expected = schema.type as string;
    const actual = Array.isArray(data) ? "array" : data === null ? "null" : typeof data;
    if (expected !== actual) {
      errors.push({ path, message: `Expected ${expected}, got ${actual}`, keyword: "type" });
      return errors;
    }
  }

  if (schema.enum && Array.isArray(schema.enum)) {
    if (!schema.enum.includes(data)) {
      errors.push({ path, message: `Value must be one of: ${schema.enum.join(", ")}`, keyword: "enum" });
    }
  }

  if (typeof data === "number") {
    if (typeof schema.minimum === "number" && data < schema.minimum) {
      errors.push({ path, message: `Value ${data} is below minimum ${schema.minimum}`, keyword: "minimum" });
    }
    if (typeof schema.maximum === "number" && data > schema.maximum) {
      errors.push({ path, message: `Value ${data} exceeds maximum ${schema.maximum}`, keyword: "maximum" });
    }
  }

  if (typeof data === "string") {
    if (typeof schema.minLength === "number" && data.length < schema.minLength) {
      errors.push({ path, message: `String length ${data.length} is below minLength ${schema.minLength}`, keyword: "minLength" });
    }
    if (typeof schema.maxLength === "number" && data.length > schema.maxLength) {
      errors.push({ path, message: `String length ${data.length} exceeds maxLength ${schema.maxLength}`, keyword: "maxLength" });
    }
    if (schema.pattern) {
      const re = new RegExp(schema.pattern as string);
      if (!re.test(data)) {
        errors.push({ path, message: `String does not match pattern "${schema.pattern}"`, keyword: "pattern" });
      }
    }
  }

  if (Array.isArray(data) && schema.type === "array") {
    if (typeof schema.minItems === "number" && data.length < (schema.minItems as number)) {
      errors.push({ path, message: `Array has ${data.length} items, minimum is ${schema.minItems}`, keyword: "minItems" });
    }
    if (typeof schema.maxItems === "number" && data.length > (schema.maxItems as number)) {
      errors.push({ path, message: `Array has ${data.length} items, maximum is ${schema.maxItems}`, keyword: "maxItems" });
    }
    if (schema.items && typeof schema.items === "object") {
      for (let i = 0; i < data.length; i++) {
        errors.push(...validate(data[i], schema.items as Record<string, unknown>, `${path}[${i}]`, strict));
      }
    }
  }

  if (data !== null && typeof data === "object" && !Array.isArray(data) && schema.type === "object") {
    const obj = data as Record<string, unknown>;
    const props = (schema.properties || {}) as Record<string, Record<string, unknown>>;
    const required = (schema.required || []) as string[];

    for (const key of required) {
      if (!(key in obj)) {
        errors.push({ path: `${path}.${key}`, message: `Required property "${key}" is missing`, keyword: "required" });
      }
    }

    for (const [key, value] of Object.entries(obj)) {
      if (props[key]) {
        errors.push(...validate(value, props[key], `${path}.${key}`, strict));
      } else if (strict && schema.additionalProperties === false) {
        errors.push({ path: `${path}.${key}`, message: `Additional property "${key}" is not allowed`, keyword: "additionalProperties" });
      }
    }
  }

  return errors;
}

export async function express(input: ValidatorInput): Promise<ValidatorOutput> {
  const { data, schema, strict = false } = input;

  if (!schema || typeof schema !== "object") {
    return { valid: false, errors: [{ path: "$", message: "Invalid schema provided", keyword: "schema" }], errorCount: 1 };
  }

  const errors = validate(data, schema, "$", strict);
  return { valid: errors.length === 0, errors, errorCount: errors.length };
}
