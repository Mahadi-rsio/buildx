import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface GraphifyIndexState {
  status: "ready" | "empty_project" | "indexing" | "updating" | "failed" | "unavailable";
  version?: string;
  nodeCount?: number;
  lastUpdated?: number;
}

export interface GraphifyQueryResult {
  nodes: Array<{
    id: string;
    label?: string;
    source_file?: string;
    community?: number;
    community_name?: string;
    file_type?: string;
    norm_label?: string;
    _callable?: boolean;
    _callable_class?: boolean;
    _origin?: string;
    _ts_fields?: unknown;
  }>;
  edges: Array<{
    source: string;
    target: string;
    label?: string;
  }>;
}

export interface GraphifySearchResult {
  mode: "graphify" | "rg";
  results: Array<{
    file: string;
    line?: number;
    content?: string;
    relevance?: number;
  }>;
  query: string;
}

/**
 * Check if graphify is available and get index state
 */
export function getGraphifyState(): GraphifyIndexState {
  try {
    const result = execSync("graphify status", { encoding: "utf8", timeout: 10000 }).trim();
    if (!result) {
      return { status: "unavailable" };
    }
    return { status: "ready", version: result };
  } catch {
    try {
      const graphPath = join(process.cwd(), "graphify-out", "graph.json");
      if (existsSync(graphPath)) {
        const graphData = JSON.parse(readFileSync(graphPath, "utf8"));
        return {
          status: "ready",
          version: graphData.graph?.graphify_version,
          nodeCount: graphData.graph?.nodes?.length,
        };
      }
      return { status: "empty_project" };
    } catch {
      return { status: "unavailable" };
    }
  }
}

/**
 * Extract a bounded subgraph using graphify query
 * @param query The search query
 * @param maxNodes Maximum nodes to return (default 50)
 * @returns Query result with nodes and edges, or null
 */
export function queryGraphify(query: string, maxNodes: number = 50): GraphifyQueryResult | null {
  try {
    const output = execSync(`graphify query "${query}"`, {
      encoding: "utf8",
      timeout: 30000,
    }).trim();

    if (!output) {
      return null;
    }

    const lines = output.split("\n");
    const result: GraphifyQueryResult = { nodes: [], edges: [] };
    let i = 0;

    // Skip header lines, find NODE and EDGE lines
    while (i < lines.length && !lines[i].startsWith("NODE") && !lines[i].startsWith("EDGE")) {
      i++;
    }

    // Parse nodes
    while (i < lines.length && lines[i].startsWith("NODE")) {
      const nodeLine = lines[i].substring(5).trim();
      const parts = nodeLine.split(" ");
      const nodeId = parts[0];
      const nodeData: GraphifyQueryResult["nodes"][0] = { id: nodeId };

      for (let j = 1; j < parts.length; j++) {
        const part = parts[j];
        if (part.includes("=")) {
          const [key, ...valueParts] = part.split("=");
          const props = nodeData as unknown as Record<string, unknown>;
          props[key] = valueParts.join("=");
        }
      }

      result.nodes.push(nodeData);
      i++;
    }

    // Parse edges
    while (i < lines.length && lines[i].startsWith("EDGE")) {
      const edgeLine = lines[i].substring(5).trim();
      const edgeParts = edgeLine.split(" -- ");
      if (edgeParts.length >= 2) {
        result.edges.push({
          source: edgeParts[0].trim(),
          target: edgeParts[1].trim(),
        });
      }
      i++;
    }

    result.nodes = result.nodes.slice(0, maxNodes);
    return result;
  } catch {
    return null;
  }
}

/**
 * Search using Graphify first, then fall back to "rg"
 * @param query The search query
 * @param maxResults Maximum results to return
 * @returns Search result with mode and results
 */
export function searchCode(query: string, maxResults: number = 20): GraphifySearchResult {
  // Try Graphify first
  const graphifyResult = queryGraphify(query, maxResults);

  if (graphifyResult && graphifyResult.nodes.length > 0) {
    const results: GraphifySearchResult["results"] = [];

    for (const node of graphifyResult.nodes) {
      const file = node.source_file || node.id;
      const label = node.norm_label || node.label || "";

      results.push({
        file,
        content: label,
        relevance: 0.8,
      });
    }

    return {
      mode: "graphify",
      results,
      query,
    };
  }

  // Fall back to "rg" search
  const rgResults = searchWithRg(query, maxResults);

  return {
    mode: "rg",
    results: rgResults,
    query,
  };
}

/**
 * Search using ripgrep ("rg") with safe limits
 * @param query The search query
 * @param maxResults Maximum results to return
 * @returns rg search results
 */
function searchWithRg(query: string, maxResults: number): Array<{
  file: string;
  line?: number;
  content?: string;
  relevance?: number;
}> {
  try {
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const output = execSync(
      `rg --max-results=${maxResults} --line-number --no-heading --sort=path "${escapedQuery}"`,
      { encoding: "utf8", timeout: 15000 }
    ).trim();

    if (!output) {
      return [];
    }

    const results: Array<{
      file: string;
      line?: number;
      content?: string;
      relevance?: number;
    }> = [];

    for (const line of output.split("\n")) {
      if (!line.trim()) continue;

      const parts = line.split(":");
      if (parts.length >= 2) {
        const file = parts[0];
        const lineNum = parseInt(parts[1], 10);
        const content = parts.slice(2).join(":").trim();

        results.push({
          file,
          line: lineNum,
          content,
          relevance: 0.6,
        });
      }
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Initialize the Graphify index lazily when source files first appear
 */
export function ensureGraphifyIndex(): {
  success: boolean;
  state: GraphifyIndexState;
  message: string;
} {
  const state = getGraphifyState();

  if (state.status === "ready") {
    return {
      success: true,
      state,
      message: "Graphify index is ready",
    };
  }

  if (state.status === "empty_project") {
    return {
      success: true,
      state: { ...state, status: "ready" },
      message: "No source files to index; index will be ready when files appear",
    };
  }

  try {
    execSync("graphify extract . --code-only", {
      timeout: 60000,
      stdio: "pipe",
    });

    const newState = getGraphifyState();
    return {
      success: true,
      state: newState,
      message: "Graphify index built successfully",
    };
  } catch (error) {
    return {
      success: false,
      state: { status: "failed" },
      message: `Graphify index build failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Get guidance on when to use Graphify vs rg search
 */
export function getSearchGuidance(query: string, context: "code_edit" | "code_search" | "navigation"): {
  preferred: "graphify" | "rg";
  reason: string;
} {
  const graphifyState = getGraphifyState();

  if (graphifyState.status !== "ready") {
    return { preferred: "rg", reason: "Graphify index not yet built" };
  }

  if (context === "navigation") {
    return { preferred: "graphify", reason: "Graphify provides community-structured code graph for navigation" };
  }

  const isSpecificPattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(query.trim());

  if (isSpecificPattern) {
    return { preferred: "graphify", reason: `Specific pattern "${query}" better searched via code graph` };
  }

  if (query.includes(" ") || query.includes("\n")) {
    return { preferred: "rg", reason: "Multi-word query better handled by rg exact text search" };
  }

  return { preferred: "graphify", reason: "Graphify provides structured code understanding" };
}
