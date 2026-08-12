/**
 * @fileoverview EmailTemplates — the /gws/email-templates marketplace island.
 *
 * Lists Gmail-safe HTML email templates (GET /api/gws/email-templates), each
 * rendered in a sandboxed iframe preview, and lets the user add their own via a
 * shadcn Dialog (POST /api/gws/email-templates). Built-in templates are badged.
 */

"use client";

import { Plus, RefreshCw } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fetchJson } from "@/lib/error-log";
import { getSessionToken } from "@/lib/session";

type Template = {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  isBuiltin: boolean;
  html: string;
};

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const { token } = getSessionToken();
  return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
}

export function EmailTemplates() {
  const [templates, setTemplates] = React.useState<Template[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [form, setForm] = React.useState({ name: "", category: "", description: "", html: "" });

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchJson<{ templates: Template[] }>(
        "/api/gws/email-templates",
        { headers: authHeaders() },
        { source: "email-templates:list", friendly: "Couldn't load email templates." },
      );
      setTemplates(data.templates ?? []);
    } catch {
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const add = React.useCallback(async () => {
    if (!form.name.trim() || !form.html.trim()) return;
    setBusy(true);
    try {
      await fetchJson(
        "/api/gws/email-templates",
        { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(form) },
        { source: "email-templates:add", friendly: "Couldn't add the template." },
      );
      setOpen(false);
      setForm({ name: "", category: "", description: "", html: "" });
      await load();
    } catch {
      /* logged by fetchJson */
    } finally {
      setBusy(false);
    }
  }, [form, load]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Badge variant="outline" className="font-mono text-[11px]">
          {templates ? `${templates.length} templates` : "…"}
        </Badge>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
            Refresh
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="size-4" />
                Add template
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add email template</DialogTitle>
                <DialogDescription>HTML is sanitized and CSS-inlined for Gmail on save. Use {"{{placeholders}}"} for fill-in fields.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <Input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                <Input placeholder="Category (optional)" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
                <Input placeholder="Description (optional)" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                <Textarea
                  placeholder="<table>…</table> — inline-styled HTML"
                  value={form.html}
                  onChange={(e) => setForm({ ...form, html: e.target.value })}
                  className="min-h-40 font-mono text-xs"
                />
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button onClick={() => void add()} disabled={busy || !form.name.trim() || !form.html.trim()}>
                  Add
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {loading && !templates ? (
        <p className="rounded-xl bg-card p-8 text-center text-sm text-muted-foreground ring-1 ring-border/40">Loading templates…</p>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          {templates?.map((t) => (
            <div key={t.id} className="overflow-hidden rounded-xl bg-card ring-1 ring-border/40">
              <div className="flex items-center justify-between gap-2 px-4 py-3">
                <div>
                  <div className="text-sm font-semibold">{t.name}</div>
                  {t.description && <div className="text-xs text-muted-foreground">{t.description}</div>}
                </div>
                <div className="flex shrink-0 gap-1">
                  {t.category && <Badge variant="outline" className="text-[10px]">{t.category}</Badge>}
                  {t.isBuiltin && <Badge variant="secondary" className="text-[10px]">built-in</Badge>}
                </div>
              </div>
              <div className="bg-white">
                <iframe title={`${t.name} preview`} sandbox="" srcDoc={t.html} className="h-64 w-full border-0" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
