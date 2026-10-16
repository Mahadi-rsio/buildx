"use client";

import { useEffect, useState } from "react";

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  provider?: string;
}

/**
 * Loads the model catalog from `/api/models`. The server owns the default
 * (derived from `AGENT_MODEL`), so the UI never invents a model id.
 */
export function useModels() {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/models");
        if (!res.ok) throw new Error("Failed to load models");
        const data = (await res.json()) as {
          default?: string;
          models?: ModelOption[];
        };
        if (!alive) return;
        if (Array.isArray(data.models)) {
          setModels(data.models);
        }
        if (typeof data.default === "string") {
          setDefaultModel(data.default);
        }
        setError(null);
      } catch (err) {
        if (alive) {
          setError(err instanceof Error ? err.message : "Failed to load models");
        }
      } finally {
        if (alive) {
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return { models, defaultModel, loading, error };
}
