/**
 * Anthropic rejects a tool input_schema that carries oneOf, allOf or anyOf at the TOP level
 * ("input_schema does not support oneOf, allOf, or anyOf at the top level"). Some MCP and client
 * tools declare their arguments that way, and a single such tool fails the whole request.
 *
 * This flattens a top-level combinator into one plain object schema:
 * - properties are unioned; when variants define the same key differently the property becomes
 *   `{ anyOf: [...] }` (nested combinators are accepted), so no variant becomes impossible;
 * - `required` follows the combinator (allOf: union, oneOf/anyOf: intersection, so every variant
 *   stays satisfiable);
 * - for oneOf/anyOf a short "Accepts one of: ..." summary of the variants' required sets is
 *   appended to the description, since the structure itself is lost.
 *
 * It also fixes adjacent top-level shapes the API refuses: a missing type, a type array that
 * contains "object", and top-level not / if / then / else. Nested content is untouched. Schemas
 * that need no change are returned as is. The input is never mutated.
 */
import { isDeepStrictEqual } from "node:util";

type Schema = Record<string, unknown>;

const COMBINATORS = ["allOf", "anyOf", "oneOf"] as const;
const UNSUPPORTED_TOP_LEVEL = ["not", "if", "then", "else"] as const;

const isRecord = (value: unknown): value is Schema =>
  !!value && typeof value === "object" && !Array.isArray(value);

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

export function hasTopLevelCombinator(schema: unknown): boolean {
  return isRecord(schema) && COMBINATORS.some((key) => key in schema);
}

function needsNormalization(schema: Schema): boolean {
  if (hasTopLevelCombinator(schema)) return true;
  if (UNSUPPORTED_TOP_LEVEL.some((key) => key in schema)) return true;
  const type = schema.type;
  if (type === undefined) return true;
  return Array.isArray(type) && type.includes("object");
}

const formatRequired = (keys: string[]) => `{${keys.join(", ")}}`;

export function normalizeClaudeInputSchema(schema: Schema): Schema {
  if (!isRecord(schema) || !needsNormalization(schema)) return schema;

  const { allOf, anyOf, oneOf, not, if: _if, then: _then, else: _else, ...base } = schema as Schema;
  const hadCombinator = hasTopLevelCombinator(schema);

  // key -> distinct definitions in first-seen order (base first, then variants).
  const definitions = new Map<string, unknown[]>();
  const addProperties = (source: unknown) => {
    if (!isRecord(source) || !isRecord(source.properties)) return;
    for (const [key, value] of Object.entries(source.properties)) {
      const seen = definitions.get(key);
      if (!seen) definitions.set(key, [value]);
      else if (!seen.some((existing) => isDeepStrictEqual(existing, value))) seen.push(value);
    }
  };
  addProperties(base);

  const required = stringList(base.required);
  const addRequired = (keys: string[]) => {
    for (const key of keys) if (!required.includes(key)) required.push(key);
  };

  if (Array.isArray(allOf)) {
    for (const variant of allOf) {
      addProperties(variant);
      if (isRecord(variant)) addRequired(stringList(variant.required));
    }
  }

  const alternatives: string[] = [];
  for (const choices of [anyOf, oneOf]) {
    if (!Array.isArray(choices) || choices.length === 0) continue;
    let shared: string[] | null = null;
    const sets: string[][] = [];
    for (const variant of choices) {
      addProperties(variant);
      const needs = isRecord(variant) ? stringList(variant.required) : [];
      sets.push(needs);
      shared = shared === null ? needs : shared.filter((key) => needs.includes(key));
    }
    addRequired(shared ?? []);
    if (sets.some((needs) => needs.length > 0)) {
      const labels = sets.map(formatRequired);
      for (const label of labels) if (!alternatives.includes(label)) alternatives.push(label);
    }
  }

  const properties: Schema = {};
  for (const [key, defs] of definitions) {
    properties[key] = defs.length === 1 ? defs[0] : { anyOf: defs };
  }

  const out: Schema = { ...base };
  if (hadCombinator || out.type === undefined || Array.isArray(out.type)) out.type = "object";
  if (hadCombinator || isRecord(base.properties) || out.type === "object") {
    out.properties = hadCombinator || isRecord(base.properties) ? properties : {};
  }
  if (required.length > 0) out.required = required;
  else delete out.required;

  if (alternatives.length > 0) {
    const summary = `Accepts one of: ${alternatives.join(" | ")}`;
    out.description =
      typeof base.description === "string" && base.description.trim()
        ? `${base.description}\n\n${summary}`
        : summary;
  }
  return out;
}
