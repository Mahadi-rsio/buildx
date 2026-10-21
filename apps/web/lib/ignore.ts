export const IGNORED_FILE_NAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

type IgnoreRule = {
  negate: boolean;
  dirOnly: boolean;
  matchSegments: boolean;
  regex: RegExp;
};

function globToRegex(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i++;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function compileRule(raw: string): IgnoreRule | null {
  let line = raw.trim();
  if (line.length === 0 || line.startsWith("#")) return null;
  if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);

  let negate = false;
  if (line.startsWith("!")) {
    negate = true;
    line = line.slice(1);
  }

  const dirOnly = line.endsWith("/");
  if (dirOnly) line = line.slice(0, -1);
  const anchored = line.startsWith("/");
  line = line.replace(/^\/+/, "");
  if (line.length === 0) return null;

  return {
    negate,
    dirOnly,
    matchSegments: !anchored && !line.includes("/"),
    regex: globToRegex(line),
  };
}

export type IgnoreMatcher = (path: string, isDir: boolean) => boolean;

/** Compile root `.gitignore` lines into a small last-match-wins matcher. */
export function createIgnoreMatcher(lines: string[]): IgnoreMatcher {
  const rules = lines
    .slice(0, 500)
    .map(compileRule)
    .filter((rule): rule is IgnoreRule => rule !== null);

  return (path, isDir) => {
    const clean = path.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!clean) return false;
    const parts = clean.split("/");
    if (parts.some((part) => part === "node_modules" || part === ".git")) {
      return true;
    }
    if (!isDir && IGNORED_FILE_NAMES.has(parts[parts.length - 1] ?? "")) {
      return true;
    }

    const prefixes = parts
      .slice(0, -1)
      .map((_, index) => parts.slice(0, index + 1).join("/"));

    let ignored = false;
    for (const rule of rules) {
      const hit = rule.dirOnly
        ? (isDir ? [clean] : prefixes).some((path) => rule.regex.test(path))
        : rule.regex.test(clean) ||
          prefixes.some((path) => rule.regex.test(path)) ||
          (rule.matchSegments
            ? parts.some((part) => rule.regex.test(part))
            : false);
      if (hit) ignored = !rule.negate;
    }
    return ignored;
  };
}
