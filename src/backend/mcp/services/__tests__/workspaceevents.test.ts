import { describe, it, expect, vi, afterEach } from "vitest";
import { WorkspaceEventsService } from "../workspaceevents";

vi.mock("../../tokenProvider", () => ({ getAccessToken: vi.fn(async () => "at") }));

let fetchSpy: ReturnType<typeof vi.spyOn>;
afterEach(() => fetchSpy?.mockRestore());

function mock(body: unknown, status = 200) {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe("WorkspaceEventsService", () => {
  it("createSubscription posts target + eventTypes + pubsub topic", async () => {
    mock({ name: "subscriptions/1", state: "ACTIVE" });
    const svc = new WorkspaceEventsService({} as any, "s1");
    await svc.createSubscription(
      "//drive.googleapis.com/files/FILE1",
      ["google.workspace.drive.comment.v3.created"],
      "projects/p/topics/t",
      { includeResource: true },
    );
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://workspaceevents.googleapis.com/v1/subscriptions");
    expect(init.method).toBe("POST");
    const b = JSON.parse(init.body as string);
    expect(b.targetResource).toBe("//drive.googleapis.com/files/FILE1");
    expect(b.eventTypes).toContain("google.workspace.drive.comment.v3.created");
    expect(b.notificationEndpoint.pubsubTopic).toBe("projects/p/topics/t");
    expect(b.payloadOptions.includeResource).toBe(true);
  });

  it("listSubscriptions passes the filter", async () => {
    mock({ subscriptions: [{ name: "subscriptions/1" }] });
    const out = await new WorkspaceEventsService({} as any, "s1").listSubscriptions('event_types:"x"');
    expect(out.subscriptions).toHaveLength(1);
    expect(decodeURIComponent(fetchSpy.mock.calls[0][0] as string)).toContain('filter=event_types:"x"');
  });

  it("deleteSubscription issues DELETE on the resource name", async () => {
    mock({}, 200);
    await new WorkspaceEventsService({} as any, "s1").deleteSubscription("subscriptions/1");
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://workspaceevents.googleapis.com/v1/subscriptions/1");
    expect(init.method).toBe("DELETE");
  });

  it("createSubscription unwraps a long-running operation", async () => {
    fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: "operations/op-1", done: false }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: "operations/op-1",
            done: true,
            response: { name: "subscriptions/live", state: "ACTIVE" },
          }),
          { status: 200 },
        ),
      );
    const out = await new WorkspaceEventsService({} as any, "s1").createSubscription(
      "//drive.googleapis.com/files/FILE1",
      ["google.workspace.drive.file.v3.renamed"],
      "projects/p/topics/t",
      { includeDescendants: true, ttl: "3600s" },
    );
    expect(out.name).toBe("subscriptions/live");
    expect(fetchSpy.mock.calls[0][0]).toBe("https://workspaceevents.googleapis.com/v1/subscriptions");
    const posted = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(posted.driveOptions.includeDescendants).toBe(true);
    expect(posted.ttl).toBe("3600s");
    expect(fetchSpy.mock.calls[1][0]).toBe("https://workspaceevents.googleapis.com/v1/operations/op-1");
  });
});
