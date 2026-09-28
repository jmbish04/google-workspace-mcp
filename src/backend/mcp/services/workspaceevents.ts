/**
 * @fileoverview Google Workspace Events API — fine-grained event subscriptions
 * (workspaceevents.googleapis.com/v1). Richer than Drive changes.watch: you
 * subscribe a target resource (a file or shared drive) to specific CloudEvents
 * event types (e.g. google.workspace.drive.comment.v3.created,
 * google.workspace.drive.file.v3.contentChanged) and events are delivered to a
 * Cloud Pub/Sub topic. Comment/reply events include mentioned + assignee email
 * addresses — useful for "agent tagged in a comment" workflows.
 *
 * Delivery infra (Pub/Sub topic + a push subscription to this Worker's
 * `/api/webhooks/workspace?token=<WORKER_API_KEY>`) is configured out-of-band;
 * these tools just manage the Workspace Events subscription lifecycle. Classic
 * Drive `changes.watch` channels still land on `/api/gws/drive-webhook`.
 */
import { googleJson, googleFetch } from "../googleClient";

const BASE = "https://workspaceevents.googleapis.com/v1";

export type WorkspaceSubscription = {
  name?: string;
  targetResource?: string;
  eventTypes?: string[];
  state?: string;
  /** RFC-3339 instant at which Google drops this subscription. */
  expireTime?: string;
  notificationEndpoint?: { pubsubTopic?: string };
};

type LongRunningOperation = {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string };
  response?: WorkspaceSubscription;
};

export class WorkspaceEventsService {
  constructor(private env: Env, private sub: string) {}

  /**
   * Create a subscription. `targetResource` is like
   * `//drive.googleapis.com/files/FILE_ID` or `//drive.googleapis.com/drives/DRIVE_ID`.
   * `pubsubTopic` is like `projects/PROJECT/topics/TOPIC`.
   *
   * @param targetResource - Workspace resource URI
   * @param eventTypes - CloudEvent types to receive
   * @param pubsubTopic - Destination Pub/Sub topic
   * @param opts - Payload / Drive descendant options / subscription TTL
   * @returns The created (ACTIVE) subscription
   * @throws GoogleApiError or a timeout if the long-running operation never completes
   */
  async createSubscription(
    targetResource: string,
    eventTypes: string[],
    pubsubTopic: string,
    opts?: { includeResource?: boolean; includeDescendants?: boolean; ttl?: string },
  ): Promise<WorkspaceSubscription> {
    const body: Record<string, unknown> = {
      targetResource,
      eventTypes,
      notificationEndpoint: { pubsubTopic },
      payloadOptions: { includeResource: opts?.includeResource ?? false },
    };
    if (opts?.includeDescendants !== undefined) {
      body.driveOptions = { includeDescendants: opts.includeDescendants };
    }
    if (opts?.ttl) body.ttl = opts.ttl;
    const created = await googleJson<WorkspaceSubscription & LongRunningOperation>(
      this.env,
      this.sub,
      `${BASE}/subscriptions`,
      { method: "POST", body: JSON.stringify(body) },
    );
    if (created.name?.startsWith("subscriptions/")) return created;
    if (created.done && created.response) return created.response;
    if (created.name) return this.waitForOperation(created.name);
    return created;
  }

  /**
   * Poll a Workspace Events long-running operation until the subscription is ready.
   *
   * @param name - Operation resource name (`operations/…`)
   * @returns The subscription from `operation.response`
   * @throws When the operation reports an error or exceeds 30s
   */
  async waitForOperation(name: string): Promise<WorkspaceSubscription> {
    const opName = name.startsWith("operations/") ? name : `operations/${name}`;
    for (let i = 0; i < 30; i++) {
      const op = await googleJson<LongRunningOperation>(this.env, this.sub, `${BASE}/${opName}`);
      if (op.done) {
        if (op.error) throw new Error(op.error.message ?? JSON.stringify(op.error));
        return op.response ?? {};
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Timed out waiting for Workspace Events operation ${opName}`);
  }

  /**
   * List subscriptions, paging through to the end.
   *
   * The Events API requires a `filter` (e.g.
   * `event_types:"google.workspace.drive.file.v3.contentChanged"` or
   * `target_resource="//drive.googleapis.com/files/ID"`).
   *
   * Paging is not optional at this worker's scale: the API returns 100 per
   * page, and an unpaged call quietly reported 100 when 253 existed — a caller
   * scanning that list for a target would conclude "not present" from a page
   * boundary. Never reason about what exists from a listing you did not page
   * to the end.
   *
   * @param filter - Events API filter expression (required by Google)
   * @param maxPages - Safety stop so a pathological cursor cannot loop forever
   * @returns Every matching subscription
   * @example
   * const { subscriptions } = await svc.listSubscriptions(
   *   `target_resource="//drive.googleapis.com/files/${id}"`,
   * );
   */
  async listSubscriptions(
    filter: string,
    maxPages = 50,
  ): Promise<{ subscriptions: WorkspaceSubscription[]; truncated: boolean }> {
    const all: WorkspaceSubscription[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const params = new URLSearchParams({ filter, pageSize: "100" });
      if (pageToken) params.set("pageToken", pageToken);
      const out = await googleJson<{
        subscriptions?: WorkspaceSubscription[];
        nextPageToken?: string;
      }>(this.env, this.sub, `${BASE}/subscriptions?${params}`);
      all.push(...(out.subscriptions ?? []));
      pageToken = out.nextPageToken;
    } while (pageToken && ++pages < maxPages);
    // Say so rather than let a cap masquerade as the full set.
    return { subscriptions: all, truncated: Boolean(pageToken) };
  }

  /** Get a subscription by resource name (`subscriptions/SUBSCRIPTION_ID`). */
  async getSubscription(name: string): Promise<WorkspaceSubscription> {
    return googleJson<WorkspaceSubscription>(this.env, this.sub, `${BASE}/${name}`);
  }

  /** Delete a subscription by resource name. */
  async deleteSubscription(name: string): Promise<{ ok: true }> {
    await googleFetch(this.env, this.sub, `${BASE}/${name}`, { method: "DELETE" });
    return { ok: true };
  }

  /**
   * Renew a subscription to its maximum expiration.
   *
   * `PATCH ?updateMask=ttl` with `{"ttl":"0s"}` means "the maximum" — 7 days
   * when the payload carries no resource data, 4 hours when it does. There is
   * no longer option, so every standing subscription needs a renewal sweep.
   *
   * @param name - Subscription resource name (`subscriptions/ID`)
   * @returns The renewed subscription, carrying the new `expireTime`
   * @example
   * const s = await svc.renewSubscription("subscriptions/drive-file-abc");
   */
  async renewSubscription(name: string): Promise<WorkspaceSubscription> {
    return googleJson<WorkspaceSubscription>(
      this.env,
      this.sub,
      `${BASE}/${name}?updateMask=ttl`,
      { method: "PATCH", body: JSON.stringify({ ttl: "0s" }) },
    );
  }

  /** Reactivate a suspended subscription by resource name. */
  async reactivateSubscription(name: string): Promise<WorkspaceSubscription> {
    return googleJson<WorkspaceSubscription>(this.env, this.sub, `${BASE}/${name}:reactivate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }
}
