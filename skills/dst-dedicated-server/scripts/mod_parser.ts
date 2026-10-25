/** A deliberately non-executable subset of Lua table constructors. */
export type Enabled = "true" | "false" | "unknown";
export interface Mod { id: string; enabled: Enabled }
interface Token { kind: "string" | "number" | "word" | "punct"; text: string }
type Value = string | number | boolean | null | Map<string, Value> | { unknown: string };
function tokens(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    const comment = source.startsWith("--", i);
    const start = i + (comment ? 2 : 0);
    const long = /^\[(=*)\[/.exec(source.slice(start));
    if (long) {
      const endMark = `]${long[1]}]`;
      const end = source.indexOf(endMark, start + long[0].length);
      if (end < 0) throw new Error("unsupported/malformed Lua: unterminated long string/comment");
      if (!comment) out.push({ kind: "string", text: source.slice(start + long[0].length, end) });
      i = end + endMark.length; continue;
    }
    if (comment) { const end = source.indexOf("\n", i); i = end < 0 ? source.length : end + 1; continue; }
    const char = source[i];
    if (char === '"' || char === "'") {
      i++; let text = "", closed = false;
      while (i < source.length) {
        const c = source[i++];
        if (c === char) { closed = true; break; }
        if (c === "\n" || c === "\r") throw new Error("unsupported/malformed Lua: newline in short string");
        if (c !== "\\") { text += c; continue; }
        const escaped = source[i++];
        const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"', "'": "'" };
        if (!(escaped in escapes)) throw new Error("unsupported Lua string escape");
        text += escapes[escaped];
      }
      if (!closed) throw new Error("unsupported/malformed Lua: unterminated string");
      out.push({ kind: "string", text }); continue;
    }
    const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(source.slice(i));
    if (word) { out.push({ kind: "word", text: word[0] }); i += word[0].length; continue; }
    const number = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i));
    if (number) { out.push({ kind: "number", text: number[0] }); i += number[0].length; continue; }
    if ("{}[]=,;".includes(char)) { out.push({ kind: "punct", text: char }); i++; continue; }
    // Do not echo source text: configuration_options can contain credentials.
    throw new Error("unsupported/malformed Lua syntax");
  }
  return out;
}
export function parseMods(source: string): Mod[] {
  if (Buffer.byteLength(source) > 1_048_576) throw new Error("modoverrides.lua exceeds 1048576 bytes");
  const input = tokens(source);
  let at = 0, depth = 0;
  const is = (text: string) => input[at]?.text === text && input[at]?.kind !== "string";
  const take = (text: string) => { if (!is(text)) throw new Error("unsupported/malformed Lua table"); at++; };
  function value(): Value {
    if (++depth > 64) throw new Error("Lua table nesting exceeds 64");
    try {
      const token = input[at++];
      if (!token) throw new Error("malformed Lua: missing value");
      if (token.kind === "string") return token.text;
      if (token.kind === "number") {
        const n = Number(token.text); if (!Number.isFinite(n)) throw new Error("invalid Lua number"); return n;
      }
      if (token.kind === "word") {
        if (token.text === "true") return true;
        if (token.text === "false") return false;
        if (token.text === "nil") return null;
        return { unknown: token.text };
      }
      if (token.text !== "{") throw new Error("unsupported/malformed Lua value");
      const table = new Map<string, Value>();
      let index = 1;
      while (!is("}")) {
        let key: string;
        if (is("[")) {
          at++;
          const keyToken = input[at++];
          if (!keyToken || !["string", "number"].includes(keyToken.kind)) throw new Error("unsupported Lua table key");
          key = `${keyToken.kind}:${keyToken.text}`; take("]"); take("=");
        } else if (input[at]?.kind === "word" && input[at + 1]?.text === "=") {
          key = `string:${input[at++].text}`; take("=");
        } else key = `number:${index++}`;
        if (table.has(key)) throw new Error("duplicate Lua table key");
        table.set(key, value());
        if (is(",") || is(";")) at++;
        else if (!is("}")) throw new Error("unsupported/malformed Lua field separator");
      }
      take("}"); return table;
    } finally { depth--; }
  }
  take("return");
  const root = value();
  if (is(";")) at++;
  if (at !== input.length || !(root instanceof Map)) throw new Error("expected return followed by one Lua table");
  const mods: Mod[] = [];
  for (const [key, entry] of root) {
    const match = /^string:workshop-([0-9]+)$/.exec(key);
    if (!match) continue;
    if (!(entry instanceof Map)) throw new Error("Workshop entry must be a table");
    const enabled = entry.get("string:enabled");
    mods.push({ id: match[1], enabled: enabled === true ? "true" : enabled === false ? "false" : "unknown" });
  }
  return mods.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : a.id.localeCompare(b.id));
}
