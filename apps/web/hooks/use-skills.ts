"use client";

import { useEffect, useState } from "react";

export interface SkillView {
  id: string;
  name: string;
  description: string;
  source: string;
  sourceKind: "github" | "url" | "archive";
  resolvedRef: string;
  digest: string;
  scope: "user" | "project";
  installedAt: string;
  enabled: boolean;
  fileCount: number;
  totalBytes: number;
}

export interface InstallResult {
  skills: SkillView[];
  failures: Array<{ path: string; message: string }>;
}

interface SkillsResponse {
  skills?: SkillView[];
  error?: string;
  message?: string;
}

const SKILL_COUNT_TTL_MS = 30_000;

let cachedCount: { expiresAt: number; count: number } | null = null;
let inFlightCount: Promise<number> | null = null;

function errorFor(
  response: Response,
  data: { error?: string; message?: string },
): string {
  if (data.error === "schema_not_migrated") {
    return "Database migration required. Run the database migrations.";
  }
  return data.message ?? data.error ?? `Request failed (${response.status})`;
}

async function fetchSkills(): Promise<SkillView[]> {
  const response = await fetch("/api/skills", { cache: "no-store" });
  const data = (await response.json().catch(() => ({}))) as SkillsResponse;
  if (!response.ok) throw new Error(errorFor(response, data));
  return Array.isArray(data.skills) ? data.skills : [];
}

async function loadSkillCount(): Promise<number> {
  if (cachedCount && cachedCount.expiresAt > Date.now()) {
    return cachedCount.count;
  }
  if (inFlightCount) return inFlightCount;

  inFlightCount = (async () => {
    try {
      const response = await fetch("/api/skills", { cache: "no-store" });
      if (!response.ok) return 0;
      const data = (await response.json()) as SkillsResponse;
      const count = Array.isArray(data.skills)
        ? data.skills.filter((skill) => skill.enabled).length
        : 0;
      cachedCount = { expiresAt: Date.now() + SKILL_COUNT_TTL_MS, count };
      return count;
    } catch {
      return 0;
    }
  })().finally(() => {
    inFlightCount = null;
  });

  return inFlightCount;
}

export function useSkills() {
  const [skills, setSkills] = useState<SkillView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const next = await fetchSkills();
        if (!alive) return;
        setSkills(next);
        setError(null);
      } catch (caught) {
        if (!alive) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function refresh(): Promise<void> {
    try {
      const next = await fetchSkills();
      setSkills(next);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function install(input: {
    source: string;
    path?: string;
    paths?: string[];
    overwrite?: boolean;
  }): Promise<InstallResult> {
    const response = await fetch("/api/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: input.source,
        path: input.path || undefined,
        paths: input.paths?.length ? input.paths : undefined,
        overwrite: input.overwrite,
      }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      skill?: SkillView;
      skills?: SkillView[];
      failures?: Array<{ path: string; message: string }>;
    };
    if (!response.ok) throw new Error(errorFor(response, data));
    cachedCount = null;
    await refresh();
    return {
      skills: data.skills ?? (data.skill ? [data.skill] : []),
      failures: Array.isArray(data.failures) ? data.failures : [],
    };
  }

  async function uninstall(id: string): Promise<void> {
    const response = await fetch(`/api/skills/${id}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      throw new Error(errorFor(response, data));
    }
    cachedCount = null;
    await refresh();
  }

  async function setEnabled(id: string, enabled: boolean): Promise<void> {
    const response = await fetch(`/api/skills/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    if (!response.ok) throw new Error(errorFor(response, data));
    cachedCount = null;
    await refresh();
  }

  return { skills, error, loading, refresh, install, uninstall, setEnabled };
}

export function useSkillCount() {
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const next = await loadSkillCount();
      if (!alive) return;
      setCount(next);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  return { count, loading };
}
