/**
 * A deliberately small TOML reader — just enough of the grammar to read the six tables
 * `pyproject.toml` keeps dependencies in, and nothing more.
 *
 * **Why hand-rolled rather than a dependency.** Charter principle 5 makes air-gap and offline
 * builds first-class ("vendored tooling", no runtime network calls), and there is no TOML parser
 * anywhere in the tree (checked at HEAD: no `@iarna/toml`, no `smol-toml`, no `toml` in any
 * workspace `package.json`), so using one would mean adding a genuinely new vendored dependency for
 * six table lookups.
 *
 * **AMENDED (M21.7).** This comment used to say the package "deliberately has zero third-party
 * dependencies so it can be dropped into an ephemeral runner image". Both halves are now qualified:
 * the package takes exactly one dependency, `yaml`, for `kubernetes-images.ts` (`types.ts` records
 * the trade and why a hand-rolled YAML subset was refused where a hand-rolled TOML subset was
 * taken), and the runner image never contained this package at all — `apps/runner-dep/Dockerfile`
 * is `FROM scratch` plus BusyBox, with no Node runtime. The argument for hand-rolling THIS reader
 * is unchanged and does not rest on either: a new vendored dependency for six table lookups is a
 * bad trade, and a line-oriented TOML scanner's failure mode is a missing table rather than a
 * confidently wrong tree.
 *
 * **What "small" means, precisely.** This reader understands: table headers (`[a.b]`), array-of-table
 * headers (`[[a.b]]`), bare and quoted and dotted keys, basic and literal strings including their
 * multi-line (`"""` / `'''`) forms, arrays (nested, multi-line, trailing commas), and inline tables.
 * It does NOT understand dates, integers-with-underscores, floats or booleans as *values* — those
 * are read as an opaque `other`, which is correct here because every value this package cares about
 * is a string, an array of strings, or an inline table of them.
 *
 * The multi-line string and array support is not gold-plating. Both appear constantly in real
 * `pyproject.toml` files (`description = """…"""`, `classifiers = [ … ]` spanning 30 lines), and a
 * line-oriented scanner that did not track them would mistake a `[Programming Language :: …]`
 * classifier entry for a TABLE HEADER and start attributing subsequent keys to a table that does
 * not exist. That is a silent wrong-answer bug, not a missing-feature bug.
 *
 * Anything the reader cannot make sense of raises {@link ManifestParseError} rather than being
 * skipped, so a manifest we misread cannot masquerade as a manifest that declares nothing.
 */
import { ManifestParseError } from "./types.js";

export type TomlValue =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "array"; readonly items: readonly TomlValue[] }
  | { readonly kind: "table"; readonly entries: ReadonlyArray<readonly [string, TomlValue]> }
  /** A value whose type we do not model (number, bool, date). Present so structure stays correct. */
  | { readonly kind: "other"; readonly text: string };

/** One assignment, with the full dotted path of the table it appeared in. */
export interface TomlEntry {
  readonly path: readonly string[];
  readonly key: string;
  readonly value: TomlValue;
}

class Reader {
  private i = 0;

  constructor(private readonly src: string) {}

  atEnd(): boolean {
    return this.i >= this.src.length;
  }

  peek(): string {
    return this.src[this.i] ?? "";
  }

  next(): string {
    const c = this.src[this.i] ?? "";
    this.i++;
    return c;
  }

  startsWith(s: string): boolean {
    return this.src.startsWith(s, this.i);
  }

  skip(n: number): void {
    this.i += n;
  }

  /** Position, for error messages only. */
  get offset(): number {
    return this.i;
  }

  /** Whitespace, newlines and `#` comments — all of which are insignificant BETWEEN tokens. */
  skipTrivia(): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\r" || c === "\n") {
        this.i++;
        continue;
      }
      if (c === "#") {
        while (!this.atEnd() && this.peek() !== "\n") this.i++;
        continue;
      }
      return;
    }
  }

  /** Horizontal whitespace and a comment, but NOT a newline — used where a newline ends a statement. */
  skipInlineTrivia(): void {
    for (;;) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\r") {
        this.i++;
        continue;
      }
      if (c === "#") {
        while (!this.atEnd() && this.peek() !== "\n") this.i++;
        continue;
      }
      return;
    }
  }
}

/** Basic-string escapes. `\uXXXX`/`\UXXXXXXXX` are handled; the rest are single-character. */
const ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\"
};

function readBasicString(r: Reader, multiline: boolean): string {
  let out = "";
  for (;;) {
    if (r.atEnd()) throw new ManifestParseError("unterminated TOML basic string");
    if (multiline && r.startsWith('"""')) {
      r.skip(3);
      return out;
    }
    if (!multiline && r.peek() === '"') {
      r.skip(1);
      return out;
    }
    const c = r.next();
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = r.next();
    // A backslash before a newline in a multi-line string swallows the following whitespace.
    if (multiline && (e === "\n" || e === "\r")) {
      while (!r.atEnd() && /\s/.test(r.peek())) r.skip(1);
      continue;
    }
    if (e === "u" || e === "U") {
      const len = e === "u" ? 4 : 8;
      let hex = "";
      for (let k = 0; k < len; k++) hex += r.next();
      out += String.fromCodePoint(Number.parseInt(hex, 16));
      continue;
    }
    const mapped = ESCAPES[e];
    if (mapped === undefined) throw new ManifestParseError(`unknown TOML escape \\${e}`);
    out += mapped;
  }
}

function readLiteralString(r: Reader, multiline: boolean): string {
  let out = "";
  for (;;) {
    if (r.atEnd()) throw new ManifestParseError("unterminated TOML literal string");
    if (multiline && r.startsWith("'''")) {
      r.skip(3);
      return out;
    }
    if (!multiline && r.peek() === "'") {
      r.skip(1);
      return out;
    }
    out += r.next();
  }
}

/** Any string form. Assumes the caller has confirmed the cursor sits on a quote. */
function readString(r: Reader): string {
  if (r.startsWith('"""')) {
    r.skip(3);
    // TOML: a newline immediately after the opening delimiter is not part of the value.
    if (r.startsWith("\r\n")) r.skip(2);
    else if (r.peek() === "\n") r.skip(1);
    return readBasicString(r, true);
  }
  if (r.startsWith("'''")) {
    r.skip(3);
    if (r.startsWith("\r\n")) r.skip(2);
    else if (r.peek() === "\n") r.skip(1);
    return readLiteralString(r, true);
  }
  if (r.peek() === '"') {
    r.skip(1);
    return readBasicString(r, false);
  }
  r.skip(1);
  return readLiteralString(r, false);
}

const BARE_KEY_RE = /[A-Za-z0-9_-]/;

function readKey(r: Reader): string[] {
  const parts: string[] = [];
  for (;;) {
    r.skipInlineTrivia();
    const c = r.peek();
    if (c === '"' || c === "'") {
      parts.push(readString(r));
    } else {
      let bare = "";
      while (!r.atEnd() && BARE_KEY_RE.test(r.peek())) bare += r.next();
      if (bare === "") {
        throw new ManifestParseError(`expected a TOML key at offset ${r.offset}`);
      }
      parts.push(bare);
    }
    r.skipInlineTrivia();
    if (r.peek() === ".") {
      r.skip(1);
      continue;
    }
    return parts;
  }
}

function readValue(r: Reader): TomlValue {
  r.skipInlineTrivia();
  const c = r.peek();

  if (c === '"' || c === "'") return { kind: "string", value: readString(r) };

  if (c === "[") {
    r.skip(1);
    const items: TomlValue[] = [];
    for (;;) {
      r.skipTrivia();
      if (r.atEnd()) throw new ManifestParseError("unterminated TOML array");
      if (r.peek() === "]") {
        r.skip(1);
        return { kind: "array", items };
      }
      items.push(readValue(r));
      r.skipTrivia();
      if (r.peek() === ",") {
        r.skip(1);
        continue;
      }
      if (r.peek() === "]") {
        r.skip(1);
        return { kind: "array", items };
      }
      throw new ManifestParseError(`expected ',' or ']' in TOML array at offset ${r.offset}`);
    }
  }

  if (c === "{") {
    r.skip(1);
    const entries: Array<readonly [string, TomlValue]> = [];
    for (;;) {
      r.skipTrivia();
      if (r.atEnd()) throw new ManifestParseError("unterminated TOML inline table");
      if (r.peek() === "}") {
        r.skip(1);
        return { kind: "table", entries };
      }
      const key = readKey(r);
      r.skipInlineTrivia();
      if (r.next() !== "=") {
        throw new ManifestParseError(`expected '=' in TOML inline table at offset ${r.offset}`);
      }
      const value = readValue(r);
      entries.push([key.join("."), value]);
      r.skipTrivia();
      if (r.peek() === ",") {
        r.skip(1);
        continue;
      }
      if (r.peek() === "}") {
        r.skip(1);
        return { kind: "table", entries };
      }
      throw new ManifestParseError(
        `expected ',' or '}' in TOML inline table at offset ${r.offset}`
      );
    }
  }

  // A scalar we do not model: consume to the end of the value and record it opaquely. Stopping at
  // `,`/`]`/`}` matters because scalars appear inside arrays and inline tables too.
  let text = "";
  while (!r.atEnd()) {
    const ch = r.peek();
    if (ch === "\n" || ch === "," || ch === "]" || ch === "}" || ch === "#") break;
    text += r.next();
  }
  if (text.trim() === "") {
    throw new ManifestParseError(`expected a TOML value at offset ${r.offset}`);
  }
  return { kind: "other", text: text.trim() };
}

/**
 * Scan a TOML document into a flat list of `(table path, key, value)`.
 *
 * A flat list, rather than a nested object, because every consumer here asks "give me the entries
 * of table X" and a flat list answers that without any merge semantics — and merge semantics are
 * where a partial TOML implementation gets subtly wrong (dotted keys inside a table header, the
 * same table opened twice, arrays of tables). Keeping the shape flat keeps the reader honest about
 * how little it claims to understand.
 *
 * @throws {ManifestParseError} on anything it cannot parse.
 */
export function scanToml(content: string): TomlEntry[] {
  const r = new Reader(content);
  const out: TomlEntry[] = [];
  let path: string[] = [];

  for (;;) {
    r.skipTrivia();
    if (r.atEnd()) return out;

    if (r.peek() === "[") {
      // `[[array of tables]]` — consumed so the cursor stays correct. Its keys are attributed to
      // the same path; no dependency table in pyproject.toml is an array-of-tables, so nothing here
      // depends on distinguishing them.
      r.skip(r.startsWith("[[") ? 2 : 1);
      path = readKey(r);
      r.skipInlineTrivia();
      while (!r.atEnd() && r.peek() === "]") r.skip(1);
      continue;
    }

    const key = readKey(r);
    r.skipInlineTrivia();
    if (r.next() !== "=") {
      throw new ManifestParseError(`expected '=' after TOML key at offset ${r.offset}`);
    }
    const value = readValue(r);

    // A dotted key (`tool.poetry.dependencies.requests = "^2"`) extends the current table path; the
    // LAST segment is the key. Handling this is what lets a file written in dotted-key style read
    // identically to one written with table headers.
    const leading = key.slice(0, -1);
    const last = key[key.length - 1];
    if (last === undefined) throw new ManifestParseError("empty TOML key");
    out.push({ path: [...path, ...leading], key: last, value });
  }
}

/** All entries assigned directly inside the table at `path` (exact match, not a prefix match). */
export function tableEntries(entries: readonly TomlEntry[], path: readonly string[]): TomlEntry[] {
  return entries.filter(
    (e) => e.path.length === path.length && e.path.every((seg, idx) => seg === path[idx])
  );
}
