import { Box, BoxError } from "@upstash/box";
import { getDb } from "@buildx/db";
import { workspaces, eq } from "@buildx/db";

const BOX_NAME_PREFIX = "buildx-ws-";

/** Generate a stable Box name from a workspace ID. */
function boxNameForWorkspace(workspaceId: string): string {
  const slug = workspaceId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${BOX_NAME_PREFIX}${slug.slice(0, 40)}`;
}

/** Try to find an existing box by name; returns the Box instance or null. */
async function getBoxByName(
  name: string,
  apiKey: string,
  baseUrl?: string,
): Promise<Box | null> {
  try {
    const box = await Box.getByName(name, { apiKey, baseUrl });
    return box;
  } catch (error) {
    if (
      error instanceof BoxError &&
      typeof error.statusCode === "number" &&
      error.statusCode === 404
    ) {
      return null;
    }
    throw error;
  }
}

/** Provision a dedicated Upstash Box for a workspace.
 *  Idempotent: if a box with the generated name already exists,
 *  it reuses it instead of creating a duplicate.
 *  Saves the box_id to the workspace record.
 *
 *  Returns the Box instance and the box_id string.
 */
export async function provisionWorkspaceBox(
  workspaceId: string,
  _userId: string,
): Promise<{ box: Box; boxId: string }> {
  const db = getDb();
  const apiKey = (process.env.UPSTASH_BOX_API_KEY ?? "").trim();
  const baseUrl = (process.env.UPSTASH_BOX_BASE_URL ?? "").trim() || undefined;

  if (!apiKey) {
    throw new Error("UPSTASH_BOX_API_KEY is required");
  }

  const boxName = boxNameForWorkspace(workspaceId);
  const existingBox = await getBoxByName(boxName, apiKey, baseUrl);

  let box: Box;
  if (existingBox) {
    box = existingBox;
  } else {
    box = await Box.create({
      name: boxName,
      runtime: "node",
      // The free plan only supports the Small (4 GB RAM / 5 GB disk) box.
      // Larger tiers are displayed in the UI but cannot be provisioned here.
      size: "small",
      keepAlive: false,
      apiKey,
      baseUrl,
    });
  }

  // Persist the box_id to the workspace record (idempotent upsert)
  await db
    .update(workspaces)
    .set({
      box_id: boxName,
      status: "ready",
      updatedAt: new Date(),
    })
    .where(eq(workspaces.id, workspaceId));

  return { box, boxId: boxName };
}

/** Recover a workspace that may be stuck in provisioning.
 *  Checks if the box_id referenced in the database actually exists.
 *  If the box is missing, attempts to reconnect or recreate.
 *  Updates workspace status accordingly.
 */
export async function recoverWorkspaceBox(
  workspaceId: string,
): Promise<{ box: Box | null; boxId: string | null; status: string }> {
  const db = getDb();
  const row = await db
    .select({ box_id: workspaces.box_id, status: workspaces.status })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (row.length === 0) {
    return { box: null, boxId: null, status: "not_found" };
  }

  const { box_id: boxId, status: currentStatus } = row[0];
  const apiKey = (process.env.UPSTASH_BOX_API_KEY ?? "").trim();
  const baseUrl = (process.env.UPSTASH_BOX_BASE_URL ?? "").trim() || undefined;

  if (!apiKey) {
    return { box: null, boxId: null, status: "failed" };
  }

  let box: Box | null = null;
  const boxName = boxId ?? "";

  if (boxId) {
    box = await getBoxByName(boxId, apiKey, baseUrl);
  }

  // If box doesn't exist but workspace is ready, try to reconnect
  if (!box && currentStatus === "ready") {
    // Box may have been auto-paused by Upstash; try to resume
    try {
      box = await Box.getByName(boxName, { apiKey, baseUrl });
    } catch {
      // Box truly missing; mark as recovering
      await db
        .update(workspaces)
        .set({ status: "recovering", updatedAt: new Date() })
        .where(eq(workspaces.id, workspaceId));
      return { box: null, boxId, status: "recovering" };
    }
  }

  // If box still doesn't exist and workspace is provisioning/failed, try to recreate
  if (!box) {
    try {
      const newBox = await Box.create({
        name: boxName,
        runtime: "node",
        size: "small",
        keepAlive: false,
        apiKey,
        baseUrl,
      });
      box = newBox;
      await db
        .update(workspaces)
        .set({ box_id: boxName, status: "ready", updatedAt: new Date() })
        .where(eq(workspaces.id, workspaceId));
    } catch {
      await db
        .update(workspaces)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(workspaces.id, workspaceId));
      return { box: null, boxId, status: "failed" };
    }
  }

  return { box, boxId, status: currentStatus };
}

/** Cancel and suspend the Box for a workspace. */
export async function cancelWorkspaceBox(
  workspaceId: string,
): Promise<void> {
  const db = getDb();
  const row = await db
    .select({ box_id: workspaces.box_id })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  if (row.length === 0) return;

  const boxId = row[0].box_id;
  if (!boxId) return;

  try {
    const { Box } = await import("@upstash/box");
    const apiKey = (process.env.UPSTASH_BOX_API_KEY ?? "").trim();
    const baseUrl = (process.env.UPSTASH_BOX_BASE_URL ?? "").trim() || undefined;

    const box = await Box.getByName(boxId, { apiKey, baseUrl });
    await box.pause().catch(() => undefined);
  } catch {
    // Box may already be deleted; best-effort
  }

  // Mark workspace as deleting
  await db
    .update(workspaces)
    .set({ status: "deleting", updatedAt: new Date() })
    .where(eq(workspaces.id, workspaceId));
}