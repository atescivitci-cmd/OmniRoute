// Edit only selected top-level members. Untouched JSON tokens (including large
// integers, exponent forms and nested values) are never parsed and reserialized.
export function editJsonObjectMembers(
  text: string,
  remove: (key: string, raw: string) => boolean
): string {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return text;
    const ws = (c: string) => c === " " || c === "\t" || c === "\r" || c === "\n";
    let pos = 0;
    while (ws(text[pos])) pos++;
    if (text[pos] !== "{") return text;
    const open = pos++;
    const members: Array<{ start: number; end: number; drop: boolean }> = [];
    const keys = new Set<string>();
    while (true) {
      const start = pos;
      while (ws(text[pos])) pos++;
      if (text[pos] === "}") break;
      const keyStart = pos++;
      while (pos < text.length) {
        if (text[pos] === "\\") {
          pos += 2;
          continue;
        }
        if (text[pos++] === '"') break;
      }
      const key = JSON.parse(text.slice(keyStart, pos));
      // Dropping a duplicate null could resurrect an earlier non-null value.
      // Preserve ambiguous duplicate-key objects for native client validation.
      if (keys.has(key)) return text;
      keys.add(key);
      while (ws(text[pos])) pos++;
      if (text[pos++] !== ":") return text;
      while (ws(text[pos])) pos++;
      const valueStart = pos;
      let depth = 0;
      let quoted = false;
      while (pos < text.length) {
        const c = text[pos];
        if (quoted) {
          if (c === "\\") {
            pos += 2;
            continue;
          }
          if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === "{" || c === "[") depth++;
        else if (c === "}" || c === "]") {
          if (depth === 0) break;
          depth--;
        } else if (c === "," && depth === 0) break;
        pos++;
      }
      members.push({ start, end: pos, drop: remove(key, text.slice(valueStart, pos).trim()) });
      if (text[pos] === "}") break;
      if (text[pos++] !== ",") return text;
    }
    if (!members.some((member) => member.drop)) return text;
    return (
      text.slice(0, open + 1) +
      members
        .filter((member) => !member.drop)
        .map((member) => text.slice(member.start, member.end))
        .join(",") +
      text.slice(pos)
    );
  } catch {
    return text;
  }
}

// Native nonstream Claude tool inputs are objects, not argument strings. Preserve
// numeric lexemes that a Number round-trip would change until final JSON encoding.
export function parseToolArgumentsLosslessly(text: string): unknown {
  return JSON.parse(text, (_key, value, context?: { source?: string }) => {
    if (typeof value !== "number") return value;
    if (typeof context?.source !== "string")
      throw new Error("Lossless tool-number parsing is unavailable");
    if (JSON.stringify(value) === context.source) return value;
    const rawJSON = (JSON as typeof JSON & { rawJSON?: (text: string) => unknown }).rawJSON;
    if (!rawJSON) throw new Error("Lossless tool-number encoding is unavailable");
    return rawJSON(context.source);
  });
}
