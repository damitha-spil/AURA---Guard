import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_DIFF_PREFS, LARGE_FILE_LINES, updateDiffPrefs, useDiffPrefs, type DiffPrefs } from "@/lib/diff-prefs";

function Row({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-40 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      {children}
    </div>
  );
}

function Pick<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger className="w-44" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([v, text]) => (
          <SelectItem key={v} value={v}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function DiffSettings() {
  const prefs = useDiffPrefs();
  return (
    <div className="grid gap-6">
      <section className="grid gap-3">
        <h2 className="text-sm font-semibold">Diffs</h2>
        <div className="divide-y rounded-2xl border">
          <Row title="Diff layout" description="Side by side falls back to stacked when there is not enough room.">
            <Pick<DiffPrefs["layout"]> label="Diff layout" value={prefs.layout} options={[["stacked", "Stacked"], ["split", "Side by side"]]} onChange={(layout) => updateDiffPrefs({ layout })} />
          </Row>
          <Row title="Hide whitespace changes" description="Leave out changes that only touch spaces and line endings.">
            <Switch aria-label="Hide whitespace changes" checked={prefs.hideWhitespace} onCheckedChange={(hideWhitespace) => updateDiffPrefs({ hideWhitespace })} />
          </Row>
          <Row title="Default diff file state" description={`How files start in a diff. Files over ${LARGE_FILE_LINES} diff lines always start collapsed.`}>
            <Pick<DiffPrefs["files"]> label="Default diff file state" value={prefs.files} options={[["expanded", "Expanded"], ["collapsed", "Collapsed"]]} onChange={(files) => updateDiffPrefs({ files })} />
          </Row>
          <Row title="Changed files list" description="A flat list, or folders you can open and close with their + and - totals. You can also switch in the diff itself.">
            <Pick<DiffPrefs["fileList"]> label="Changed files list" value={prefs.fileList} options={[["list", "List"], ["tree", "Folder tree"]]} onChange={(fileList) => updateDiffPrefs({ fileList })} />
          </Row>
          <Row title="Diff colors" description="Added and removed lines keep their + and - marks with either choice.">
            <Pick<DiffPrefs["colors"]> label="Diff colors" value={prefs.colors} options={[["red-green", "Red & green"], ["orange-blue", "Orange & blue"]]} onChange={(colors) => updateDiffPrefs({ colors })} />
          </Row>
          <div data-diff-colors={prefs.colors} className="p-4">
            <pre aria-label="Colour preview" className="overflow-hidden rounded-xl border py-1 font-mono text-xs">
              <div className="diff-del-line px-3">- const retries = 1;</div>
              <div className="diff-add-line px-3">+ const retries = 3;</div>
            </pre>
          </div>
        </div>
      </section>
      <section className="grid gap-3">
        <h2 className="text-sm font-semibold">Pull requests</h2>
        <div className="rounded-2xl border">
          <Row title="Open pull requests in SPIL REO" description="On: a pull request opens its details here. Off: it opens its https link in the browser.">
            <Switch aria-label="Open pull requests in SPIL REO" checked={prefs.openPullsInApp} onCheckedChange={(openPullsInApp) => updateDiffPrefs({ openPullsInApp })} />
          </Row>
        </div>
      </section>
      <Button variant="outline" size="sm" className="justify-self-end" onClick={() => updateDiffPrefs(DEFAULT_DIFF_PREFS)}>
        <RotateCcw />
        Reset to defaults
      </Button>
    </div>
  );
}
