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

  /** List subscriptions. The Events API requires a `filter` (e.g. `event_types:"google.workspace.drive.file.v3.contentChanged"` or a target resource). */
  async listSubscriptions(filter: string): Promise<{ subscriptions: WorkspaceSubscription[]; nextPageToken?: string }> {
    const out = await googleJson<{ subscriptions?: WorkspaceSubscription[]; nextPageToken?: string }>(
      this.env,
      this.sub,
      `${BASE}/subscriptions?filter=${encodeURIComponent(filter)}`,
    );
    return { subscriptions: out.subscriptions ?? [], nextPageToken: out.nextPageToken };
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

  /** Reactivate a suspended subscription by resource name. */
  async reactivateSubscription(name: string): Promise<WorkspaceSubscription> {
    return googleJson<WorkspaceSubscription>(this.env, this.sub, `${BASE}/${name}:reactivate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }
}
