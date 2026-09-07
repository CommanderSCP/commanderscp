/** A minimal glob matcher for the mapping patterns. See docs/coordination.md §543. */
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // A single alternation-ordered replace — `**` is tried before `*` at every position, so there
  // is no intermediate placeholder character needed (an earlier version used a `\x00` sentinel
  // byte here, which both tripped eslint's `no-control-regex` rule and made this file look like
  // binary content to git/most editors).
  const regexSource = escaped.replace(/\*\*|\*/g, (match) => (match === "**" ? ".*" : "[^/]*"));
  return new RegExp(`^${regexSource}$`).test(value);
}
