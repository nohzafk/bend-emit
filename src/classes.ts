// classes.ts: emit each constructor literal {$: "T", "a": x, "b": y} as `new $T_T_a_b(x, y)` on a
// class with one fixed field order, and emit each constructor with no fields as one shared instance.
//
// The class rewrite on its own was measured neutral: with a literal, every value of a constructor is
// written at one site in one field order, so the runtime gives them one hidden class anyway. It is kept
// as the half that makes the other half possible -- once the emitter knows a constructor's field list, a
// constructor with none becomes one shared value instead of a fresh object per construction, and that
// measured about 20% off the peak on a token-heavy core.
//
// The sharing is visible to a host: two nullary values of the same constructor are now the same object,
// so `a === b` is true where the literal form made it false. Values carrying fields are still fresh.
function close(s: string, i: number): number {
  let d = 0;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (ch === '"' || ch === "'" || ch === "`") { for (j++; j < s.length && s[j] !== ch; j++) if (s[j] === "\\") j++; continue; }
    if (ch === "(" || ch === "{" || ch === "[") d++;
    else if (ch === ")" || ch === "}" || ch === "]") { if (--d === 0) return j; if (d < 0) return -1; }
  }
  return -1;
}
function splitTop(s: string): string[] {
  const out: string[] = [];
  let d = 0, cur = "";
  for (let j = 0; j < s.length; j++) {
    const ch = s[j];
    if (ch === '"' || ch === "'" || ch === "`") { const st = j; for (j++; j < s.length && s[j] !== ch; j++) if (s[j] === "\\") j++; cur += s.slice(st, j + 1); continue; }
    if ("({[".includes(ch)) d++;
    if (")}]".includes(ch)) d--;
    if (ch === "," && d === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}
export function classify(js: string): string {
  const classes = new Map<string, string>();
  const conv = (s: string): string => {
    let out = "", i = 0;
    for (;;) {
      const k = s.indexOf('{$: "', i);
      if (k < 0) return out + s.slice(i);
      const e = close(s, k);
      if (e < 0) return out + s.slice(i);
      const inner = s.slice(k + 1, e);
      const parts = splitTop(inner);
      const tag = parts[0].match(/^\$: "([^"]*)"$/);
      const fs = parts.slice(1).map((p) => p.match(/^("[^"]+"|[A-Za-z_$][\w$]*): ([\s\S]*)$/));
      if (!tag || fs.some((m) => !m) || /[^\w$"]/.test(tag[1].replace(/"/g, ""))) { out += s.slice(i, k + 1); i = k + 1; continue; }
      const names = fs.map((m) => m![1].replace(/"/g, ""));
      const cname = `$C$${tag[1]}${names.map((n) => "$" + n).join("")}`;
      if (!classes.has(cname)) {
        const ps = names.map((_, j) => `a${j}`);
        classes.set(cname, `class ${cname} { constructor(${ps.join(", ")}) { this.$ = "${tag[1]}";${names.map((n, j) => ` this.${n} = a${j};`).join("")} } }`);
      }
      if (names.length === 0) {
        if (!classes.has("$N$" + tag[1])) classes.set("$N$" + tag[1], `const $N$${tag[1]} = new ${cname}();`);
        out += s.slice(i, k) + `$N$${tag[1]}`; i = e + 1; continue;
      }
      out += s.slice(i, k) + `new ${cname}(${fs.map((m) => conv(m![2])).join(", ")})`;
      i = e + 1;
    }
  };
  const body = conv(js);
  if (classes.size === 0) return body;
  return [...classes.values()].join("\n") + "\n" + body;
}
