// Secret redaction, applied before truncation, storage or any LLM call.
// Patterns follow gitleaks' common rules plus a generic key=value/entropy catch.

const RULES: [string, RegExp][] = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ["anthropic", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g],
  ["github", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g],
  ["gitlab", /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ["slack", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g],
  ["google-api", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["stripe", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g],
  ["huggingface", /\bhf_[A-Za-z0-9]{30,}\b/g],
  ["npm", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["sendgrid", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g],
  ["google-oauth", /\bGOCSPX-[A-Za-z0-9_-]{20,}/g],
  ["telegram", /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g],
  ["twilio", /\bSK[0-9a-f]{32}\b/g],
  ["discord", /\b[MN][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["bearer", /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/g],
  ["url-credentials", /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi],
];

// KEY=value / "key": "value" where the key name suggests a secret. "auth"/"token" must be whole
// name segments so authHeader / tokenizer / token_count aren't caught.
const KV =
  /\b((?:[A-Za-z0-9]+[_.-])*(?:secret|token|passw(?:or)?d|pass|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth|credentials?|session[_-]?key|client[_-]?secret)(?:[_.-][A-Za-z0-9]+)*)(["']?\s*[:=]\s*["']?)([^\s"'`,;]{6,})/gi;

const PASSWORDISH = /(pass|pwd|secret)/i;

function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [name, re] of RULES) {
    out = out.replace(re, (m, p1) => {
      if (name === "url-credentials") return `${p1}[REDACTED]@`;
      if (name === "bearer") return `${p1} [REDACTED:${name}]`;
      return `[REDACTED:${name}]`;
    });
  }
  out = out.replace(KV, (m, key: string, sep: string, val: string) => {
    if (val.startsWith("[REDACTED") || val.startsWith("$") || val.startsWith("process.env")) return m;
    if (/^(true|false|null|undefined|none|string|number|required|optional)$/i.test(val)) return m;
    if (/^[A-Za-z_]\w*(\.\w+)+$/.test(val) || /\w\(/.test(val) || /^\d+$/.test(val)) return m; // code: obj.prop, fn(, counts
    if (!PASSWORDISH.test(key) && val.length < 12 && entropy(val) < 3) return m; // passwords redacted regardless
    return `${key}${sep}[REDACTED:kv]`;
  });
  return out;
}
