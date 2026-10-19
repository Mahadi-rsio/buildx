"use client";

import { useEffect, useState } from "react";

export interface AgentConfigProvider {
  id: string;
  label: string;
  baseURL: string | null;
  hasApiKey: boolean;
  primary: boolean;
}

export interface AgentConfig {
  hasApiKey: boolean;
  model: string;
  maxSteps: number;
  baseURL: string | null;
  defaultProvider: string;
  providers: AgentConfigProvider[];
}

export function useConfig() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/config");
        const data = (await res.json()) as AgentConfig;
        if (!alive) return;
        setConfig(data);
        setError(null);
      } catch {
        if (alive) setError("Could not load agent config");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return { config, error, loading };
}
