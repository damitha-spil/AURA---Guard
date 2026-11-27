import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts";
import { BarChart3 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/app/page";
import { useAppearance } from "@/lib/appearance";

export interface DefectLite {
  severity: string;
  status: string;
  testedDate: string;
}
export interface RunLite {
  id: string;
  generatedAt: string;
  scorecard: { defectsCount: number; totalCases: number; passRate: number | null };
}
export interface NoteLite {
  status: string;
}

function Shell({
  title,
  description,
  loading,
  empty,
  children,
}: {
  title: string;
  description: string;
  loading: boolean;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-48 w-full" />
        ) : empty ? (
          <EmptyState icon={BarChart3} title="No data yet" />
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

const sevConfig = {
  critical: { label: "Critical", color: "var(--chart-5)" },
  high: { label: "High", color: "var(--chart-4)" },
  medium: { label: "Medium", color: "var(--chart-2)" },
  low: { label: "Low", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function DefectsOverTime({ defects, loading }: { defects: DefectLite[]; loading: boolean }) {
  const calm = useAppearance().reduceMotion;
  const days = Array.from(new Set(defects.map((d) => d.testedDate))).sort();
  const data = days.map((day) => {
    const row: Record<string, string | number> = { day: day.slice(5) };
    for (const s of Object.keys(sevConfig)) {
      row[s] = defects.filter((d) => d.testedDate === day && d.severity === s).length;
    }
    return row;
  });
  return (
    <Shell title="Defects over time" description="Logged per day, by severity" loading={loading} empty={data.length === 0}>
      <ChartContainer config={sevConfig} className="h-48 w-full">
        <AreaChart data={data}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="day" tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} width={24} tickLine={false} axisLine={false} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <ChartLegend content={<ChartLegendContent />} />
          {Object.keys(sevConfig).map((s) => (
            <Area isAnimationActive={calm ? false : "auto"}
              key={s}
              dataKey={s}
              type="monotone"
              stackId="a"
              fill={sevConfig[s as keyof typeof sevConfig].color}
              stroke={sevConfig[s as keyof typeof sevConfig].color}
              fillOpacity={0.4}
            />
          ))}
        </AreaChart>
      </ChartContainer>
    </Shell>
  );
}

const statusConfig = { count: { label: "Defects", color: "var(--chart-3)" } } satisfies ChartConfig;

export function DefectsByStatus({ defects, loading }: { defects: DefectLite[]; loading: boolean }) {
  const calm = useAppearance().reduceMotion;
  const data = ["open", "triaged", "notified", "fixed", "false_positive"].map((s) => ({
    status: s.replace("_", " "),
    count: defects.filter((d) => d.status === s).length,
  }));
  return (
    <Shell title="Defects by status" description="Where work stands" loading={loading} empty={defects.length === 0}>
      <ChartContainer config={statusConfig} className="h-48 w-full">
        <BarChart data={data}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="status" tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} width={24} tickLine={false} axisLine={false} />
          <ChartTooltip content={<ChartTooltipContent hideLabel />} />
          <Bar isAnimationActive={calm ? false : "auto"} dataKey="count" fill={statusConfig.count.color} radius={[8, 8, 0, 0]} />
        </BarChart>
      </ChartContainer>
    </Shell>
  );
}

const runConfig = {
  defects: { label: "Defects", color: "var(--chart-5)" },
  cases: { label: "Cases", color: "var(--chart-2)" },
} satisfies ChartConfig;

export function RunsOverTime({ runs, loading }: { runs: RunLite[]; loading: boolean }) {
  const calm = useAppearance().reduceMotion;
  const data = [...runs]
    .sort((a, b) => a.generatedAt.localeCompare(b.generatedAt))
    .slice(-14)
    .map((r) => ({
      day: r.generatedAt.slice(5, 10),
      defects: r.scorecard.defectsCount,
      cases: r.scorecard.totalCases,
    }));
  return (
    <Shell title="QA runs over time" description="Cases and defects for the latest runs" loading={loading} empty={data.length === 0}>
      <ChartContainer config={runConfig} className="h-48 w-full">
        <BarChart data={data}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="day" tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} width={24} tickLine={false} axisLine={false} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar isAnimationActive={calm ? false : "auto"} dataKey="cases" fill={runConfig.cases.color} radius={[8, 8, 0, 0]} />
          <Bar isAnimationActive={calm ? false : "auto"} dataKey="defects" fill={runConfig.defects.color} radius={[8, 8, 0, 0]} />
        </BarChart>
      </ChartContainer>
    </Shell>
  );
}

const noteColors = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

export function NotesByStatus({ notes, loading }: { notes: NoteLite[]; loading: boolean }) {
  const calm = useAppearance().reduceMotion;
  const statuses = Array.from(new Set(notes.map((n) => n.status)));
  const data = statuses.map((s) => ({ status: s, count: notes.filter((n) => n.status === s).length }));
  const config: ChartConfig = Object.fromEntries(
    statuses.map((s, i) => [s, { label: s, color: noteColors[i % noteColors.length] }]),
  );
  return (
    <Shell title="Vault notes by status" description="Knowledge base health" loading={loading} empty={data.length === 0}>
      <ChartContainer config={config} className="mx-auto h-48 w-full">
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="status" />} />
          <Pie isAnimationActive={calm ? false : "auto"} data={data} dataKey="count" nameKey="status" innerRadius={42} strokeWidth={2}>
            {data.map((d, i) => (
              <Cell key={d.status} fill={noteColors[i % noteColors.length]} />
            ))}
          </Pie>
          <ChartLegend content={<ChartLegendContent nameKey="status" />} />
        </PieChart>
      </ChartContainer>
    </Shell>
  );
}
