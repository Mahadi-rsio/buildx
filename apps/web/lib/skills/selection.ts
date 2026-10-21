export interface SelectableSkill {
  path: string;
  name: string;
  description?: string;
  valid?: boolean;
}

export interface InstalledSkillLike {
  name: string;
}

/** Case-insensitive filter across skill name, path and description. */
export function filterSkillCandidates<T extends SelectableSkill>(
  candidates: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return candidates;
  return candidates.filter((candidate) =>
    [candidate.name, candidate.path, candidate.description ?? ""].some((value) =>
      value.toLowerCase().includes(needle),
    ),
  );
}

/** Multi-skill sources start with every valid candidate selected. */
export function selectAllValid(candidates: SelectableSkill[]): Set<string> {
  return new Set(
    candidates.filter((candidate) => candidate.valid !== false).map((candidate) => candidate.path),
  );
}

export function toggleSelected(current: Set<string>, path: string): Set<string> {
  const next = new Set(current);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

export function selectedCandidates<T extends SelectableSkill>(
  candidates: T[],
  selected: ReadonlySet<string>,
): T[] {
  return candidates.filter((candidate) => selected.has(candidate.path));
}

export function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()))];
}

export function installedSkillNames(installed: InstalledSkillLike[]): Set<string> {
  return new Set(installed.map((skill) => skill.name));
}

/** Names that would replace an existing installation in the current scope. */
export function duplicateCandidateNames(
  candidates: SelectableSkill[],
  installed: InstalledSkillLike[],
): Set<string> {
  const names = installedSkillNames(installed);
  return new Set(
    candidates.filter((candidate) => names.has(candidate.name)).map((candidate) => candidate.name),
  );
}
