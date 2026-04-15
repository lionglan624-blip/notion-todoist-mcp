// ─────────────────────────────────────────────
// Date expression evaluator (JST-aware)
// Supported: "today", "yesterday", "tomorrow",
//   "today+7d", "today-30d", "today+2w", "today+1m", "today+1y", "now"
//   ISO date/datetime strings pass through as-is.
// ─────────────────────────────────────────────
export function evalDate(expr) {
  if (!expr || typeof expr !== "string") return expr;

  // JST offset: UTC+9
  const nowUTC = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const nowJST = new Date(nowUTC.getTime() + jstOffset);
  const todayJST = new Date(
    Date.UTC(nowJST.getUTCFullYear(), nowJST.getUTCMonth(), nowJST.getUTCDate())
  );

  const isoDate = (d) => d.toISOString().split("T")[0];

  if (expr === "now")       return nowJST.toISOString().replace("Z", "+09:00");
  if (expr === "today")     return isoDate(todayJST);
  if (expr === "yesterday") { const d = new Date(todayJST); d.setUTCDate(d.getUTCDate() - 1); return isoDate(d); }
  if (expr === "tomorrow")  { const d = new Date(todayJST); d.setUTCDate(d.getUTCDate() + 1); return isoDate(d); }

  // today±N[dwmy]
  const rel = expr.match(/^today([+-])(\d+)([dwmy])$/);
  if (rel) {
    const [, sign, num, unit] = rel;
    const n = parseInt(num, 10) * (sign === "+" ? 1 : -1);
    const d = new Date(todayJST);
    if (unit === "d") d.setUTCDate(d.getUTCDate() + n);
    if (unit === "w") d.setUTCDate(d.getUTCDate() + n * 7);
    if (unit === "m") d.setUTCMonth(d.getUTCMonth() + n);
    if (unit === "y") d.setUTCFullYear(d.getUTCFullYear() + n);
    return isoDate(d);
  }

  return expr; // ISO date/datetime pass-through
}

// Recursively resolve date expressions inside a Notion filter object
export function resolveFilterDates(filter) {
  if (!filter || typeof filter !== "object") return filter;
  if (Array.isArray(filter)) return filter.map(resolveFilterDates);

  const out = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k === "date" && typeof v === "object" && v !== null) {
      out[k] = {};
      for (const [op, val] of Object.entries(v)) {
        const dateOps = ["equals","before","after","on_or_before","on_or_after"];
        out[k][op] = dateOps.includes(op) ? evalDate(val) : val;
      }
    } else if (typeof v === "object" && v !== null) {
      out[k] = resolveFilterDates(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─────────────────────────────────────────────
// Safe math evaluator
// Recursive descent parser — no eval/new Function (CF Workers compatible)
// Supports: +  -  *  /  %  ^  unary-  ()  Math.*  numeric literals
// ─────────────────────────────────────────────
export function safeMath(expr) {
  if (!expr || typeof expr !== "string") throw new Error("Expression required");

  // ── Tokenizer ──────────────────────────────
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(expr[i + 1] ?? ""))) {
      let num = "";
      while (i < expr.length && /[0-9.]/.test(expr[i])) num += expr[i++];
      if ((num.match(/\./g) || []).length > 1) throw new Error(`Invalid number: ${num}`);
      tokens.push({ t: "num", v: parseFloat(num) });
    } else if (/[a-zA-Z_]/.test(c)) {
      let id = "";
      while (i < expr.length && /[a-zA-Z0-9_]/.test(expr[i])) id += expr[i++];
      tokens.push({ t: "id", v: id });
    } else if ("+-*/%(),.^".includes(c)) {
      tokens.push({ t: "op", v: c });
      i++;
    } else {
      throw new Error(`Unexpected character: ${c}`);
    }
  }
  tokens.push({ t: "eof", v: "" });

  // ── Supported Math.* ──────────────────────
  const MATH_FN = {
    round: Math.round, floor: Math.floor, ceil: Math.ceil,
    sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs,
    exp: Math.exp, log: Math.log, log2: Math.log2, log10: Math.log10,
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    pow: Math.pow, hypot: Math.hypot,
    min: Math.min, max: Math.max,
    trunc: Math.trunc, sign: Math.sign,
  };
  const MATH_CONST = {
    PI: Math.PI, E: Math.E,
    LN2: Math.LN2, LN10: Math.LN10,
    LOG2E: Math.LOG2E, LOG10E: Math.LOG10E,
    SQRT2: Math.SQRT2, SQRT1_2: Math.SQRT1_2,
  };

  // ── Parser ────────────────────────────────
  let pos = 0;
  const peek   = ()  => tokens[pos];
  const consume = () => tokens[pos++];
  const expectOp = (v) => {
    if (peek().v !== v) throw new Error(`Expected '${v}', got '${peek().v || peek().t}'`);
    return consume();
  };

  // expr  = term  (('+' | '-') term)*
  function parseExpr() {
    let v = parseTerm();
    while (peek().v === "+" || peek().v === "-") {
      const op = consume().v;
      const r = parseTerm();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }

  // term  = unary (('*' | '/' | '%') unary)*
  function parseTerm() {
    let v = parseUnary();
    while (["*", "/", "%"].includes(peek().v)) {
      const op = consume().v;
      const r = parseUnary();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  }

  // unary = ('-' | '+') unary  |  pow
  // Lower precedence than '^' so -2^2 === -(2^2) === -4 (standard math convention)
  function parseUnary() {
    if (peek().v === "-") { consume(); return -parseUnary(); }
    if (peek().v === "+") { consume(); return parseUnary(); }
    return parsePow();
  }

  // pow   = atom ('^' unary)?   (right-associative via unary → pow recursion)
  // 2^3^2 === 2^(3^2) === 512;   2^-3 === 0.125
  function parsePow() {
    const v = parseAtom();
    if (peek().v === "^") { consume(); return Math.pow(v, parseUnary()); }
    return v;
  }

  // atom  = NUMBER | '(' expr ')' | 'Math' '.' IDENT ('(' args ')')?
  function parseAtom() {
    const t = peek();
    if (t.t === "num") { consume(); return t.v; }
    if (t.v === "(") {
      consume();
      const v = parseExpr();
      expectOp(")");
      return v;
    }
    if (t.t === "id") {
      if (t.v === "Math") {
        consume();
        expectOp(".");
        const name = peek();
        if (name.t !== "id") throw new Error(`Expected Math.* name after '.'`);
        consume();
        if (peek().v === "(") {
          // Function call — hasOwn guards against prototype members like
          // `constructor` / `toString` leaking through the `in` operator.
          if (!Object.hasOwn(MATH_FN, name.v)) throw new Error(`Unknown Math function: Math.${name.v}`);
          consume(); // '('
          const args = [];
          if (peek().v !== ")") {
            args.push(parseExpr());
            while (peek().v === ",") { consume(); args.push(parseExpr()); }
          }
          expectOp(")");
          return MATH_FN[name.v](...args);
        } else {
          // Constant
          if (!Object.hasOwn(MATH_CONST, name.v)) throw new Error(`Unknown Math constant: Math.${name.v}`);
          return MATH_CONST[name.v];
        }
      }
      throw new Error(`Unknown identifier: ${t.v}`);
    }
    throw new Error(`Unexpected token: ${t.v || t.t}`);
  }

  let result;
  try {
    result = parseExpr();
    if (peek().t !== "eof") throw new Error(`Unexpected token after expression: '${peek().v}'`);
  } catch (e) {
    throw new Error(`Math error: ${e.message}`);
  }
  if (typeof result !== "number" || !isFinite(result)) {
    throw new Error("Result is not a finite number");
  }
  return result;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Strip collection:// prefix and, when the ID is a dash-less Notion UUID,
// re-insert the canonical dashes. Validating hex-only here prevents
// non-UUID garbage (e.g. ``zzzz...``) from being silently reshaped into
// a dashed string that then gets forwarded to the Notion API.
export function normalizeId(id) {
  if (id == null) return id;
  if (typeof id !== "string") {
    throw new Error(`id must be a string, got ${typeof id}`);
  }
  const stripped = id.replace(/^collection:\/\//, "").replace(/-/g, "");
  if (/^[0-9a-f]{32}$/i.test(stripped)) {
    return stripped.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
  }
  return stripped;
}

// Extract numeric value from any Notion property
export function extractNum(prop) {
  if (!prop) return null;
  if (prop.type === "number") return prop.number;
  if (prop.type === "formula") return prop.formula?.number ?? null;
  if (prop.type === "rollup") {
    if (prop.rollup?.type === "number") return prop.rollup.number;
    if (prop.rollup?.type === "array") {
      const nums = (prop.rollup.array || []).map(extractNum).filter(n => n !== null);
      return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
    }
  }
  return null;
}
