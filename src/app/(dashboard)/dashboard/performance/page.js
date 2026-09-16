"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Area, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { AI_PROVIDERS, getProviderByAlias } from "@/shared/constants/providers";

const PERIODS = [
  { value: "today", label: "Today" }, { value: "24h", label: "24h" },
  { value: "7d", label: "7D" }, { value: "30d", label: "30D" }, { value: "90d", label: "90D" },
];
const GROUPS = [{ value: "provider", label: "Providers" }, { value: "model", label: "Models" }, { value: "account", label: "Accounts" }];
const integer = (value) => new Intl.NumberFormat("en-US").format(value || 0);
const duration = (value) => value == null ? "—" : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
const percentage = (value) => value == null ? "—" : `${value.toFixed(1)}%`;
const speed = (value) => value == null ? "—" : `${value.toFixed(1)} tok/s`;
const providerName = (id) => AI_PROVIDERS[id]?.name || getProviderByAlias(id)?.name || id;
const tooltipStyle = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, fontSize: 12 };
const selectClass = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/50";

function Metric({ label, value, note, icon, color = "text-text-main" }) {
  return (
    <Card padding="sm" className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-text-muted">
        <span className="text-xs font-semibold uppercase tracking-wide">{label}</span>
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">{icon}</span>
      </div>
      <span className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</span>
      <span className="text-xs text-text-muted">{note}</span>
    </Card>
  );
}

function ComparisonTable({ groups }) {
  const [group, setGroup] = useState("model");
  const [sort, setSort] = useState({ field: "attempts", descending: true });
  const [page, setPage] = useState(0);
  const rows = useMemo(() => [...groups[group]].sort((left, right) => {
    if (left[sort.field] == null) return right[sort.field] == null ? 0 : 1;
    if (right[sort.field] == null) return -1;
    return (left[sort.field] - right[sort.field]) * (sort.descending ? -1 : 1);
  }), [groups, group, sort]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 20) - 1));
  const columns = [
    { field: "attempts", label: "Attempts", format: integer },
    { field: "successRate", label: "Success", format: percentage },
    { field: "medianTtftMs", label: "Median TTFT", format: duration },
    { field: "p95TtftMs", label: "p95 TTFT", format: duration },
    { field: "p95LatencyMs", label: "p95 duration", format: duration },
    { field: "medianOutputTps", label: "Output speed", format: speed },
    { field: "errors", label: "Errors", format: integer },
  ];
  return (
    <Card padding="none" className="min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div><h2 className="font-semibold">Compare performance</h2><p className="mt-1 text-xs text-text-muted">Click a column to sort. Missing measurements are shown as —.</p></div>
        <SegmentedControl options={GROUPS} value={group} onChange={(value) => { setGroup(value); setPage(0); }} size="sm" />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full whitespace-nowrap text-sm">
          <thead className="border-y border-border-subtle bg-bg-subtle text-xs text-text-muted">
            <tr><th scope="col" className="px-4 py-3 text-left">{group === "provider" ? "Provider" : group === "model" ? "Model" : "Account"}</th>
              {columns.map((column) => <th key={column.field} scope="col" className="px-4 py-3 text-right" aria-sort={sort.field === column.field ? sort.descending ? "descending" : "ascending" : "none"}>
                <button type="button" className="hover:text-text-main" onClick={() => { setSort({ field: column.field, descending: sort.field === column.field ? !sort.descending : true }); setPage(0); }}>
                  {column.label}{sort.field === column.field ? sort.descending ? " ↓" : " ↑" : ""}
                </button>
              </th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {rows.slice(currentPage * 20, currentPage * 20 + 20).map((row) => (
              <tr key={row.key} className="hover:bg-bg-subtle">
                <th scope="row" className="max-w-[260px] px-4 py-3 text-left font-medium">
                  <div className="truncate" title={group === "account" ? row.accountName : row.model}>{group === "provider" ? providerName(row.provider) : group === "model" ? row.model : row.accountName}</div>
                  <div className="text-xs font-normal text-text-muted">{group !== "provider" && `${providerName(row.provider)} · `}{group === "model" && `${row.mode === "fast" ? "Fast" : row.mode === "standard" ? "Standard" : "Unknown mode"} · `}{integer(row.ttftSamples)} TTFT samples</div>
                </th>
                {columns.map((column) => <td key={column.field} className={`px-4 py-3 text-right tabular-nums ${column.field === "errors" && row.errors ? "text-error" : ""}`}>{column.format(row[column.field])}</td>)}
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={8} className="px-4 py-10 text-center text-text-muted">No recorded attempts match these filters.</td></tr>}
          </tbody>
        </table>
      </div>
      {rows.length > 20 && <div className="flex items-center justify-between gap-2 border-t border-border-subtle p-4 text-xs text-text-muted">
        <span>{currentPage * 20 + 1}–{Math.min(rows.length, currentPage * 20 + 20)} of {integer(rows.length)}</span>
        <div className="flex gap-2"><Button variant="secondary" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</Button><Button variant="secondary" size="sm" disabled={(currentPage + 1) * 20 >= rows.length} onClick={() => setPage(currentPage + 1)}>Next</Button></div>
      </div>}
    </Card>
  );
}

export default function PerformancePage() {
  const [period, setPeriod] = useState("24h");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [account, setAccount] = useState("");
  const [mode, setMode] = useState("");
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [latencyView, setLatencyView] = useState("ttft");
  const query = new URLSearchParams({ period, provider, model, connectionId: account, mode }).toString();
  const data = result?.query === query ? result.data : null;
  const currentError = error?.query === query ? error.message : null;

  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function load() {
      try {
        const response = await fetch(`/api/usage/performance?${query}`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Could not load performance metrics. Retrying automatically.");
        const payload = await response.json();
        if (!controller.signal.aborted) { setResult({ query, data: payload }); setError(null); }
      } catch (failure) {
        if (!controller.signal.aborted) setError({ query, message: failure.message });
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(load, 30000);
      }
    }
    load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [query, refresh]);

  const options = result?.data?.options || [];
  const providers = [...new Set(options.map((option) => option.provider))];
  const available = options.filter((option) => !provider || option.provider === provider);
  const models = [...new Set(available.map((option) => option.model))];
  const accounts = [...new Map(available.filter((option) => option.connectionId).map((option) => [option.connectionId, option])).values()];
  const summary = data?.summary;
  const firstToken = latencyView === "ttft";
  const chartHasTimings = data?.trend.some((bucket) => firstToken ? bucket.ttftSamples > 0 : bucket.latencySamples > 0);

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl options={PERIODS} value={period} onChange={setPeriod} size="sm" />
        <div className="flex items-center gap-3 text-xs text-text-muted">
          {data && <span>Updated {new Date(data.updatedAt).toLocaleTimeString()} · Every 30s</span>}
          <Button variant="secondary" size="sm" icon="refresh" onClick={() => setRefresh((value) => value + 1)}>Refresh</Button>
        </div>
      </div>
      <Card padding="sm" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <label className="flex min-w-0 flex-col gap-1.5 text-xs text-text-muted">Provider
          <select className={selectClass} value={provider} onChange={(event) => { setProvider(event.target.value); setModel(""); setAccount(""); }}><option value="">All providers</option>{providers.map((id) => <option key={id} value={id}>{providerName(id)}</option>)}</select>
        </label>
        <label className="flex min-w-0 flex-col gap-1.5 text-xs text-text-muted">Model
          <select className={selectClass} value={model} onChange={(event) => setModel(event.target.value)}><option value="">All models</option>{models.map((id) => <option key={id} value={id}>{id}</option>)}</select>
        </label>
        <label className="flex min-w-0 flex-col gap-1.5 text-xs text-text-muted">Account
          <select className={selectClass} value={account} onChange={(event) => setAccount(event.target.value)}><option value="">All accounts</option>{accounts.map((option) => <option key={option.connectionId} value={option.connectionId}>{option.accountName || option.connectionId} · {providerName(option.provider)}</option>)}</select>
        </label>
        <label className="flex min-w-0 flex-col gap-1.5 text-xs text-text-muted">Processing mode
          <select className={selectClass} value={mode} onChange={(event) => setMode(event.target.value)}><option value="">All modes</option><option value="standard">Standard</option><option value="fast">Fast</option><option value="unknown">Unknown (historical)</option></select>
        </label>
      </Card>
      {currentError && <div role="alert" className="rounded-lg border border-error/30 bg-error/5 p-3 text-sm text-error">{currentError}{data && " Showing the last successful refresh."}</div>}
      {!data ? <Card><div role="status" className="py-12 text-center text-sm text-text-muted">{currentError ? "Metrics are temporarily unavailable." : "Loading performance metrics…"}</div></Card> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Metric label="Recorded attempts" value={integer(summary.attempts)} note={`${integer(summary.cancelled)} cancelled · ${integer(summary.incomplete)} incomplete / unknown`} icon="query_stats" />
            <Metric label="Success rate" value={percentage(summary.successRate)} note={`${integer(summary.successes)} successful · ${integer(summary.errors)} failed`} icon="check_circle" color={summary.successRate == null ? "text-text-main" : summary.successRate >= 99 ? "text-success" : summary.successRate >= 95 ? "text-warning" : "text-error"} />
            <Metric label="Output speed" value={speed(summary.medianOutputTps)} note={`Median · ${integer(summary.throughputSamples)} measured streams`} icon="speed" color="text-primary" />
            <Metric label="Median TTFT" value={duration(summary.medianTtftMs)} note={`Time to first token · ${integer(summary.ttftSamples)} samples`} icon="timer" />
            <Metric label="p95 TTFT" value={duration(summary.p95TtftMs)} note="95% of measured first-token times are at or below this" icon="hourglass_top" />
            <Metric label="p95 duration" value={duration(summary.p95LatencyMs)} note={`Successful attempts · median ${duration(summary.medianLatencyMs)}`} icon="schedule" />
          </div>
          {data.coverage.truncated && <div role="status" className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning">High-volume view: metrics use the newest {integer(data.coverage.sampleLimit)} of {integer(data.coverage.matchingAttempts)} matching attempts. Choose a shorter period or a filter for complete coverage.</div>}
          {!summary.attempts && <Card className="text-center"><span className="material-symbols-outlined text-3xl text-text-muted" aria-hidden="true">monitoring</span><h2 className="mt-2 font-semibold">No performance samples yet</h2><p className="mt-2 text-sm text-text-muted">Send a chat request through 9Router or select a wider period. New metrics are recorded without enabling prompt logging.</p></Card>}
          <div className="grid min-w-0 gap-4 xl:grid-cols-2">
            <Card padding="sm" className="min-w-0">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Response latency</h2><SegmentedControl options={[{ value: "ttft", label: "First token" }, { value: "duration", label: "Total duration" }]} value={latencyView} onChange={setLatencyView} size="sm" /></div>
              {chartHasTimings ? <ResponsiveContainer width="100%" height={230}>
                <LineChart data={data.trend} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.12} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: "currentColor" }} minTickGap={35} tickLine={false} />
                  <YAxis tickFormatter={duration} tick={{ fontSize: 10, fill: "currentColor" }} width={66} tickLine={false} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(value, name) => [duration(value), name]} labelFormatter={(_, entries) => entries?.[0]?.payload?.timestamp ? new Date(entries[0].payload.timestamp).toLocaleString() : ""} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey={firstToken ? "medianTtftMs" : "medianLatencyMs"} name="Median" stroke="#10b981" strokeWidth={2} dot={{ r: 2 }} connectNulls={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey={firstToken ? "p95TtftMs" : "p95LatencyMs"} name="p95" stroke="#f59e0b" strokeWidth={2} dot={{ r: 2 }} connectNulls={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer> : <div className="flex h-[230px] items-center justify-center text-center text-sm text-text-muted">{firstToken ? "No measured streaming first-token times in this period." : "No successful duration samples in this period."}</div>}
            </Card>
            <Card padding="sm" className="min-w-0">
              <h2 className="mb-4 font-semibold">Attempt outcomes</h2>
              <ResponsiveContainer width="100%" height={230}>
                <ComposedChart data={data.trend} margin={{ top: 8, right: 12, left: -15, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.12} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: "currentColor" }} minTickGap={35} tickLine={false} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: "currentColor" }} tickLine={false} />
                  <Tooltip contentStyle={tooltipStyle} labelFormatter={(_, entries) => entries?.[0]?.payload?.timestamp ? new Date(entries[0].payload.timestamp).toLocaleString() : ""} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area type="stepAfter" dataKey="successes" name="Successful" stackId="outcome" stroke="#10b981" fill="#10b981" fillOpacity={0.25} isAnimationActive={false} />
                  <Area type="stepAfter" dataKey="errors" name="Failed" stackId="outcome" stroke="#ef4444" fill="#ef4444" fillOpacity={0.4} isAnimationActive={false} />
                  <Area type="stepAfter" dataKey="cancelled" name="Cancelled" stackId="outcome" stroke="#94a3b8" fill="#94a3b8" fillOpacity={0.3} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </Card>
          </div>
          <ComparisonTable key={query} groups={data.groups} />
          <div className="grid min-w-0 gap-4 lg:grid-cols-[1fr_2fr]">
            <Card padding="sm"><h2 className="mb-4 font-semibold">Failure breakdown</h2>
              {!data.failures.length ? <p className="py-6 text-sm text-text-muted">No failures recorded in this selection.</p> : <div className="flex flex-col gap-4">{data.failures.map((failure) => <div key={failure.category}><div className="mb-1.5 flex justify-between gap-2 text-xs"><span>{failure.category}</span><span className="tabular-nums text-text-muted">{integer(failure.count)}</span></div><div className="h-1.5 rounded-full bg-bg-subtle"><div className={`h-full rounded-full ${failure.category === "Cancelled" ? "bg-text-muted" : "bg-error/70"}`} style={{ width: `${failure.count / (summary.errors + summary.cancelled) * 100}%` }} /></div></div>)}</div>}
            </Card>
            <Card padding="sm" className="min-w-0"><div className="mb-4 flex items-center justify-between gap-2"><h2 className="font-semibold">Recent failures</h2><Link className="text-xs text-primary hover:underline" href="/dashboard/usage?tab=details">Request details →</Link></div>
              <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-text-muted"><tr><th className="pb-2 font-medium">Time</th><th className="pb-2 font-medium">Model</th><th className="pb-2 font-medium">Category</th><th className="pb-2 text-right font-medium">HTTP</th></tr></thead><tbody className="divide-y divide-border-subtle">{data.recentFailures.map((failure) => <tr key={failure.id}><td className="whitespace-nowrap py-3 pr-3 text-text-muted">{new Date(failure.timestamp).toLocaleString()}</td><td className="max-w-[180px] py-3 pr-3"><div className="truncate" title={failure.model}>{failure.model}</div><div className="text-text-muted">{providerName(failure.provider)}</div></td><td className="py-3 pr-3">{failure.category}</td><td className="py-3 text-right tabular-nums">{failure.httpStatus ?? "—"}</td></tr>)}</tbody></table>{!data.recentFailures.length && <p className="py-6 text-center text-sm text-text-muted">No failures to show.</p>}</div>
            </Card>
          </div>
          <Card padding="sm" className="text-xs leading-relaxed text-text-muted">
            <h2 className="mb-2 font-semibold text-text-main">How to read these metrics</h2>
            <p>Metrics cover recorded chat attempts, not unique user requests. Success rate excludes cancelled, pending, and unknown outcomes. Errors before request instrumentation and unreported stream interruptions may be absent; retry and fallback rates are not yet tracked.</p>
            <p className="mt-2">TTFT and output speed use successful streams with a separately measured first-token time. Speed is output tokens ÷ generation time after the first token. Non-streaming responses and missing measurements are excluded rather than counted as zero. Percentiles use nearest-rank samples; small samples can be noisy.</p>
            <p className="mt-2">Metadata-only history is retained for {data.coverage.retentionDays} days, independently of prompt logging. Existing retained request details are imported where available. No prompts, responses, or credentials are included in performance records. Daily buckets use {data.timeZone}.{data.coverage.retainedSince && ` Earliest retained sample: ${new Date(data.coverage.retainedSince).toLocaleString()}.`}</p>
          </Card>
        </>
      )}
    </div>
  );
}
