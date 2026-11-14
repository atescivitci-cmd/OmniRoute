/**
 * Anthropic rejects a tool input_schema that carries oneOf, allOf or anyOf at the TOP level
 * ("input_schema does not support oneOf, allOf, or anyOf at the top level"). Some MCP and client
 * tools declare their arguments that way, and a single such tool fails the whole request.
 *
 * This flattens a top-level combinator into one plain object schema: properties are unioned,
 * and `required` follows the combinator (allOf: union, oneOf/anyOf: intersection, so every
 * variant stays satisfiable). Nested combinators are untouched. Schemas without a top-level
 * combinator are returned as is. The input is never mutated.
 */
type Schema = Record<string, unknown>;

const COMBINATORS = ["allOf", "anyOf", "oneOf"] as const;

const isRecord = (value: unknown): value is Schema =>
  !!value && typeof value === "object" && !Array.isArray(value);

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

export function hasTopLevelCombinator(schema: unknown): boolean {
  return isRecord(schema) && COMBINATORS.some((key) => key in schema);
}

export function normalizeClaudeInputSchema(schema: Schema): Schema {
  if (!hasTopLevelCombinator(schema)) return schema;

  const { allOf, anyOf, oneOf, ...base } = schema as Schema & {
    allOf?: unknown;
    anyOf?: unknown;
    oneOf?: unknown;
  };

  const properties: Schema = isRecord(base.properties) ? { ...base.properties } : {};
  const baseRequired = stringList(base.required);

  const mergeProperties = (variant: unknown) => {
    if (isRecord(variant) && isRecord(variant.properties)) {
      for (const [key, value] of Object.entries(variant.properties)) {
        if (!(key in properties)) properties[key] = value;
      }
    }
  };

  let required = [...baseRequired];

  if (Array.isArray(allOf)) {
    for (const variant of allOf) {
      mergeProperties(variant);
      if (isRecord(variant)) {
        for (const key of stringList(variant.required))
          if (!required.includes(key)) required.push(key);
      }
    }
  }

  for (const choices of [anyOf, oneOf]) {
    if (!Array.isArray(choices) || choices.length === 0) continue;
    let shared: string[] | null = null;
    for (const variant of choices) {
      mergeProperties(variant);
      const needs = isRecord(variant) ? stringList(variant.required) : [];
      shared = shared === null ? needs : shared.filter((key) => needs.includes(key));
    }
    for (const key of shared ?? []) if (!required.includes(key)) required.push(key);
  }

  const out: Schema = { ...base, type: "object", properties };
  if (required.length > 0) out.required = required;
  else delete out.required;
  return out;
}
