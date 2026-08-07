/**
 * @file drive/sharing-audit.ts
 * @description Recursive Drive sharing audit + bulk permission edits, built on
 * DriveService. Designed for an AI model to answer "who can see this tree?" and
 * to remediate over-sharing.
 *
 * A capped breadth-first walk collects every descendant (files + folders) of a
 * target folder, requesting each node's permissions inline (one list call per
 * folder — see DriveService.listChildren). `auditSharing` reduces that to
 * per-account and "anyone with the link" counts; `applySharingActions` walks the
 * same tree applying add/remove permission changes.
 *
 * Walks are bounded by `maxNodes` (default 2000) so a huge tree can't exhaust
 * the Worker's subrequest budget; when the cap is hit the report/result carries
 * `truncated: true` and `scanned` reflects what was actually visited.
 */
import { DriveService, FOLDER_MIME, type DriveNode, type DrivePermission } from "@/backend/mcp/services/drive";

/** Default ceiling on nodes visited in one recursive operation. */
export const DEFAULT_MAX_NODES = 2000;

export interface WalkResult {
  /** Every descendant visited (files and folders), excluding the root itself. */
  nodes: DriveNode[];
  /** True when `maxNodes` was reached before the tree was fully traversed. */
  truncated: boolean;
}

/** Whether a permission grants link-based "anyone can access" (any role). */
export function isAnyoneWithLink(p: DrivePermission): boolean {
  return p.type === "anyone";
}

/** Case-insensitive membership helper for email lists. */
function normEmail(e: string): string {
  return e.trim().toLowerCase();
}

/**
 * Breadth-first walk of a folder's descendants, bounded by `maxNodes`. The root
 * folder itself is not included in `nodes` (audit/apply operate on its contents,
 * plus the root is added explicitly by callers that want it).
 */
export async function walkFolder(
  drive: DriveService,
  rootId: string,
  maxNodes: number = DEFAULT_MAX_NODES,
): Promise<WalkResult> {
  const nodes: DriveNode[] = [];
  const queue: string[] = [rootId];
  const seenFolders = new Set<string>([rootId]);
  let truncated = false;

  while (queue.length) {
    const folderId = queue.shift() as string;
    let pageToken: string | undefined;
    do {
      const { files, nextPageToken } = await drive.listChildren(folderId, { pageToken });
      for (const f of files) {
        if (nodes.length >= maxNodes) {
          truncated = true;
          break;
        }
        nodes.push(f);
        if (f.mimeType === FOLDER_MIME && !seenFolders.has(f.id)) {
          seenFolders.add(f.id);
          queue.push(f.id);
        }
      }
      pageToken = nextPageToken;
    } while (pageToken && !truncated);
    if (truncated) break;
  }

  return { nodes, truncated };
}

export interface AccountShareStat {
  email: string;
  /** Nodes on which this account has an explicit permission. */
  sharedCount: number;
  /** Nodes on which this account has NO explicit permission. */
  notSharedCount: number;
  /** A capped sample of shared node ids (for spot-checking). */
  sharedSample: string[];
}

export interface SharingReport {
  rootId: string;
  scannedFiles: number;
  scannedFolders: number;
  truncated: boolean;
  anyoneWithLink: {
    /** Nodes shared to anyone-with-link. */
    sharedCount: number;
    /** Nodes NOT shared to anyone-with-link. */
    notSharedCount: number;
    /** Capped sample of node ids that are anyone-with-link accessible. */
    sample: { id: string; name: string; role: string; discoverable: boolean }[];
  };
  /** Per-account sharing breakdown, only when `auditEmails` was provided. */
  accounts: AccountShareStat[];
}

const SAMPLE_CAP = 50;

/**
 * Reduce a set of walked nodes to per-account and anyone-with-link counts.
 *
 * @param auditEmails - accounts to specifically report shared/not-shared counts
 *   for. Omit for just the anyone-with-link summary.
 */
export function auditSharing(
  rootId: string,
  nodes: DriveNode[],
  truncated: boolean,
  auditEmails: string[] = [],
): SharingReport {
  const emails = auditEmails.map(normEmail);
  const perAccount = new Map<string, AccountShareStat>(
    emails.map((e) => [e, { email: e, sharedCount: 0, notSharedCount: 0, sharedSample: [] }]),
  );

  let scannedFiles = 0;
  let scannedFolders = 0;
  let anyoneShared = 0;
  const anyoneSample: SharingReport["anyoneWithLink"]["sample"] = [];

  for (const node of nodes) {
    if (node.mimeType === FOLDER_MIME) scannedFolders++;
    else scannedFiles++;

    const perms = node.permissions ?? [];
    const anyonePerm = perms.find(isAnyoneWithLink);
    if (anyonePerm) {
      anyoneShared++;
      if (anyoneSample.length < SAMPLE_CAP) {
        anyoneSample.push({
          id: node.id,
          name: node.name,
          role: anyonePerm.role,
          discoverable: anyonePerm.allowFileDiscovery === true,
        });
      }
    }

    if (emails.length) {
      const nodeEmails = new Set(perms.map((p) => (p.emailAddress ? normEmail(p.emailAddress) : "")).filter(Boolean));
      for (const e of emails) {
        const stat = getStat(perAccount, e);
        if (nodeEmails.has(e)) {
          stat.sharedCount++;
          if (stat.sharedSample.length < SAMPLE_CAP) stat.sharedSample.push(node.id);
        } else {
          stat.notSharedCount++;
        }
      }
    }
  }

  const total = nodes.length;
  return {
    rootId,
    scannedFiles,
    scannedFolders,
    truncated,
    anyoneWithLink: {
      sharedCount: anyoneShared,
      notSharedCount: total - anyoneShared,
      sample: anyoneSample,
    },
    accounts: [...perAccount.values()],
  };
}

function getStat(m: Map<string, AccountShareStat>, e: string): AccountShareStat {
  let s = m.get(e);
  if (!s) {
    s = { email: e, sharedCount: 0, notSharedCount: 0, sharedSample: [] };
    m.set(e, s);
  }
  return s;
}

export interface SharingActions {
  /** Grant "anyone with the link" this role (e.g. "reader") to every node. */
  addAnyoneWithLink?: "reader" | "commenter" | "writer";
  /** Remove all "anyone" permissions from every node. */
  removeAnyoneWithLink?: boolean;
  /** Remove these accounts' explicit permissions from every node. */
  removeEmails?: string[];
  /** Grant these accounts the given role on every node. */
  addEmails?: { email: string; role: "reader" | "commenter" | "writer" }[];
}

export interface ApplyResult {
  rootId: string;
  scanned: number;
  truncated: boolean;
  anyoneAdded: number;
  anyoneRemoved: number;
  accountsAdded: number;
  accountsRemoved: number;
  /** Per-node errors (id + message), capped. */
  errors: { id: string; message: string }[];
}

const ERROR_CAP = 50;

/**
 * Apply sharing changes across a folder's descendants (and the root folder
 * itself). Each node is fetched/modified independently; a failure on one node is
 * recorded and the walk continues.
 */
export async function applySharingActions(
  drive: DriveService,
  rootId: string,
  actions: SharingActions,
  maxNodes: number = DEFAULT_MAX_NODES,
): Promise<ApplyResult> {
  const { nodes, truncated } = await walkFolder(drive, rootId, maxNodes);
  // Include the root folder itself so a recursive grant/removal covers it too.
  const root = await drive.get(rootId).catch(() => null);
  const targets: DriveNode[] = root
    ? [{ id: root.id, name: root.name, mimeType: root.mimeType, webViewLink: root.webViewLink }, ...nodes]
    : nodes;

  const removeSet = new Set((actions.removeEmails ?? []).map(normEmail));
  const errors: ApplyResult["errors"] = [];
  let anyoneAdded = 0;
  let anyoneRemoved = 0;
  let accountsAdded = 0;
  let accountsRemoved = 0;

  const pushErr = (id: string, err: unknown) => {
    if (errors.length < ERROR_CAP) errors.push({ id, message: err instanceof Error ? err.message : String(err) });
  };

  for (const node of targets) {
    // Permission removals need the node's current permissions. The walked nodes
    // already carry them; the root was fetched without, so fetch on demand.
    let perms = node.permissions;
    const needsPerms = actions.removeAnyoneWithLink || removeSet.size > 0;
    if (needsPerms && !perms) {
      try {
        perms = (await drive.getPermissions(node.id)).permissions;
      } catch (err) {
        pushErr(node.id, err);
        perms = [];
      }
    }

    if (actions.removeAnyoneWithLink && perms) {
      for (const p of perms.filter(isAnyoneWithLink)) {
        try {
          await drive.deletePermission(node.id, p.id);
          anyoneRemoved++;
        } catch (err) {
          pushErr(node.id, err);
        }
      }
    }

    if (removeSet.size > 0 && perms) {
      for (const p of perms) {
        if (p.emailAddress && removeSet.has(normEmail(p.emailAddress))) {
          try {
            await drive.deletePermission(node.id, p.id);
            accountsRemoved++;
          } catch (err) {
            pushErr(node.id, err);
          }
        }
      }
    }

    if (actions.addAnyoneWithLink) {
      try {
        await drive.share(node.id, actions.addAnyoneWithLink, "anyone");
        anyoneAdded++;
      } catch (err) {
        pushErr(node.id, err);
      }
    }

    for (const add of actions.addEmails ?? []) {
      try {
        await drive.share(node.id, add.role, "user", add.email);
        accountsAdded++;
      } catch (err) {
        pushErr(node.id, err);
      }
    }
  }

  return {
    rootId,
    scanned: targets.length,
    truncated,
    anyoneAdded,
    anyoneRemoved,
    accountsAdded,
    accountsRemoved,
    errors,
  };
}
