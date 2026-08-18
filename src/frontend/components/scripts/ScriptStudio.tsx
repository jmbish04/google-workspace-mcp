/**
 * @file components/scripts/ScriptStudio.tsx
 * @description Island for a single downloadable script. Renders a parameter
 * form, then live-generated snippets (cURL / Python / TypeScript / Apps Script)
 * in language tabs with copy + download. All generation is client-side and pure
 * (see lib/scripts/generators) — the base URL is read from the current origin so
 * snippets point at this deployment.
 */
import * as React from "react";

import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { generateSnippets } from "@/lib/scripts/generators";
import type { ScriptSpec } from "@/lib/scripts/types";

/** Trigger a browser download of a text file. */
function downloadText(filename: string, code: string): void {
  const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function ScriptStudio({ spec }: { spec: ScriptSpec }): React.ReactElement {
  // Origin is only known in the browser; start with a stable placeholder so SSR
  // and first client render match, then fill in on mount.
  const [baseUrl, setBaseUrl] = React.useState("https://your-worker.example.com");
  React.useEffect(() => {
    setBaseUrl(window.location.origin);
  }, []);

  const [values, setValues] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(spec.params.map((p) => [p.name, p.default ?? ""])),
  );
  const [outputPath, setOutputPath] = React.useState(spec.defaultOutput ?? `~/Downloads/${spec.tool}.json`);

  const snippets = React.useMemo(
    () => generateSnippets(spec, values, baseUrl, { outputPath }),
    [spec, values, baseUrl, outputPath],
  );

  const setValue = (name: string, v: string): void => setValues((prev) => ({ ...prev, [name]: v }));

  return (
    <div className="flex flex-col gap-8">
      {/* Parameters */}
      <section className="rounded-xl bg-card p-5 ring-1 ring-border/40">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground/70">Parameters</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Fill these in and the snippets below update live. Set{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">WORKER_API_KEY</code> in your environment
          (or a Script Property for Apps Script) — it is never written into the generated code.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {spec.params.map((p) => (
            <div key={p.name} className="flex flex-col gap-1.5">
              <Label htmlFor={p.name} className="text-sm">
                {p.label}
                {p.required ? <span className="ml-1 text-destructive">*</span> : null}
                <span className="ml-2 font-mono text-[11px] text-muted-foreground/60">{p.name}</span>
              </Label>
              <Input
                id={p.name}
                value={values[p.name] ?? ""}
                inputMode={p.type === "number" ? "numeric" : "text"}
                placeholder={p.placeholder}
                onChange={(e) => setValue(p.name, e.target.value)}
              />
              {p.help ? <p className="text-xs text-muted-foreground">{p.help}</p> : null}
            </div>
          ))}

          {/* Client-only: where curl/Python/TypeScript save the response. */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="__outputPath" className="text-sm">
              Save response to
              <span className="ml-2 font-mono text-[11px] text-muted-foreground/60">output file</span>
            </Label>
            <Input
              id="__outputPath"
              value={outputPath}
              placeholder="~/Downloads/report.json"
              onChange={(e) => setOutputPath(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Local path for the downloaded JSON — curl <code className="font-mono">-o</code>, or a file write in
              Python/TS. Clear it to just print the result. (Not used by Apps Script.)
            </p>
          </div>
        </div>
      </section>

      {/* Snippets */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground/70">Download</h2>
        <Tabs defaultValue={snippets[0]?.id}>
          <TabsList>
            {snippets.map((s) => (
              <TabsTrigger key={s.id} value={s.id}>
                {s.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {snippets.map((s) => (
            <TabsContent key={s.id} value={s.id} className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                {s.files.map((f) => (
                  <Button
                    key={f.filename}
                    size="sm"
                    variant="outline"
                    onClick={() => downloadText(f.filename ?? s.filename, f.code)}
                  >
                    ↓ {f.filename}
                  </Button>
                ))}
              </div>
              <CodeBlock files={s.files} showLineNumbers maxHeight="32rem" />
            </TabsContent>
          ))}
        </Tabs>
      </section>
    </div>
  );
}
