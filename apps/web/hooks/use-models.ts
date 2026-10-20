"use client";

import { useEffect, useState } from "react";

export interface ModelOption {
  id: string;
  name: string;
  description?: string;
  provider?: string;
  /** Provider group id (`litellm` | `openrouter`) for sectioning the picker. */
  providerId?: string;
}

interface Catalog {
  models: ModelOption[];
  defaultModel: string;
}

const CATALOG_TTL_MS = 5 * 60_000;
let cachedCatalog: { expiresAt: number; catalog: Catalog } | null = null;
let inFlight: Promise<Catalog> | null = null;

async function loadCatalog(): Promise<Catalog> {
  if (cachedCatalog && cachedCatalog.expiresAt > Date.now()) {
    return cachedCatalog.catalog;
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const res = await fetch("/api/models");
    if (!res.ok) throw new Error("Failed to load models");
    const data = (await res.json()) as {
      default?: string;
      models?: ModelOption[];
    };
    const catalog: Catalog = {
      models: Array.isArray(data.models) ? data.models : [],
      defaultModel: typeof data.default === "string" ? data.default : "",
    };
    cachedCatalog = { expiresAt: Date.now() + CATALOG_TTL_MS, catalog };
    return catalog;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/**
 * Loads the model catalog from `/api/models`. The server owns the default
 * (derived from `AGENT_MODEL`), so the UI never invents a model id. Results are
 * cached in-process so multiple pickers share one fetch.
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
        const catalog = await loadCatalog();
        if (!alive) return;
        setModels(catalog.models);
        setDefaultModel(catalog.defaultModel);
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
