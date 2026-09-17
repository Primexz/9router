"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Card from "@/shared/components/Card";

const LEVELS = [
  "bg-bg-subtle border-border-subtle",
  "bg-emerald-200 border-emerald-300 dark:bg-emerald-950 dark:border-emerald-900",
  "bg-emerald-400 border-emerald-500 dark:bg-emerald-800 dark:border-emerald-700",
  "bg-emerald-600 border-emerald-700 dark:bg-emerald-600 dark:border-emerald-500",
  "bg-emerald-800 border-emerald-900 dark:bg-emerald-400 dark:border-emerald-300",
];
const formatTokens = (tokens) => new Intl.NumberFormat("en-US").format(tokens);
const parseDate = (date) => new Date(`${date}T12:00:00Z`);
const formatDate = (date) => parseDate(date).toLocaleDateString("en-US", {
  month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
});

export default function TokenActivity() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [tooltip, setTooltip] = useState(null);
  const [focusedDate, setFocusedDate] = useState(null);
  const buttons = useRef(new Map());
  const scrollArea = useRef(null);
  const tooltipId = useId();
  const hasData = data !== null;

  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function refresh() {
      try {
        const response = await fetch("/api/usage/activity", {
          signal: controller.signal, cache: "no-store",
        });
        if (!response.ok) throw new Error("Activity unavailable");
        const activity = await response.json();
        if (!controller.signal.aborted) {
          setData(activity);
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 30000);
      }
    }
    refresh();
    const reload = () => refresh();
    window.addEventListener("timezonechange", reload);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener("timezonechange", reload);
    };
  }, []);

  useEffect(() => {
    if (hasData && scrollArea.current) {
      scrollArea.current.scrollLeft = scrollArea.current.scrollWidth;
    }
  }, [hasData]);

  useEffect(() => {
    const dismissTooltip = () => setTooltip(null);
    window.addEventListener("scroll", dismissTooltip, true);
    window.addEventListener("resize", dismissTooltip);
    return () => {
      window.removeEventListener("scroll", dismissTooltip, true);
      window.removeEventListener("resize", dismissTooltip);
    };
  }, []);

  const { weeks, maximum, activeDays } = useMemo(() => {
    if (!data?.days?.length) return { weeks: [], maximum: 0, activeDays: 0 };
    const offset = parseDate(data.days[0].date).getUTCDay();
    const cells = [...Array(offset).fill(null), ...data.days];
    while (cells.length % 7) cells.push(null);
    const weeks = Array.from({ length: cells.length / 7 }, (_, index) => cells.slice(index * 7, index * 7 + 7));
    return {
      weeks,
      maximum: Math.max(...data.days.map((day) => day.tokens)),
      activeDays: data.days.filter((day) => day.tokens > 0).length,
    };
  }, [data]);

  function showTooltip(event, day) {
    const bounds = event.currentTarget.getBoundingClientRect();
    setTooltip({
      date: day.date,
      left: Math.max(140, Math.min(window.innerWidth - 140, bounds.left + bounds.width / 2)),
      top: bounds.top > 85 ? bounds.top - 8 : bounds.bottom + 8,
      above: bounds.top > 85,
    });
  }

  function handleKeyDown(event, day) {
    if (event.key === "Escape") {
      setTooltip(null);
      return;
    }
    const index = data.days.findIndex((entry) => entry.date === day.date);
    const offsets = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };
    let nextIndex;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = data.days.length - 1;
    else if (event.key in offsets) nextIndex = index + offsets[event.key];
    else return;
    event.preventDefault();
    const nextDay = data.days[Math.max(0, Math.min(data.days.length - 1, nextIndex))];
    buttons.current.get(nextDay.date)?.focus();
  }

  const selectedDay = tooltip && data?.days.find((day) => day.date === tooltip.date);

  return (
    <Card className="flex min-w-0 flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-text-main">Token activity</h3>
          <p className="mt-1 text-sm text-text-muted">
            {data ? <><span className="font-semibold text-text-main">{formatTokens(data.totalTokens)}</span> input + output tokens consumed in the last 365 days</> : error ? "Token activity is temporarily unavailable" : "Loading token activity…"}
          </p>
        </div>
        <span className="rounded-md border border-border-subtle px-2 py-1 text-xs text-text-muted">Last 365 days</span>
      </div>

      {!data ? (
        <div className="flex h-32 items-center justify-center text-sm text-text-muted" role="status">
          {error ? "Could not load activity. Retrying automatically…" : "Loading daily usage…"}
        </div>
      ) : (
        <>
          <div ref={scrollArea} className="overflow-x-auto pb-1">
            <div className="flex min-w-[700px] gap-2">
              <div className="grid shrink-0 grid-rows-7 gap-[3px] pt-6 text-[10px] text-text-muted" aria-hidden="true">
                {["", "Mon", "", "Wed", "", "Fri", ""].map((label, index) => <span key={index} className="flex items-center">{label}</span>)}
              </div>
              <div className="grid min-w-0 flex-1 gap-[3px]" style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }} role="group" aria-label="Daily token activity. Use arrow keys to navigate days, Home and End to jump, and Escape to dismiss details.">
                {weeks.map((week, weekIndex) => {
                  const monthDay = week.find((day) => day && (day.date.endsWith("-01") || day.date === data.days[0].date));
                  const month = monthDay && parseDate(monthDay.date).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
                  return (
                    <div key={weekIndex} className="flex min-w-0 flex-col gap-[3px]">
                      <div className="h-[21px] overflow-visible whitespace-nowrap text-[10px] text-text-muted" aria-hidden="true">{weekIndex < weeks.length - 2 ? month : null}</div>
                      {week.map((day, dayIndex) => {
                        if (!day) return <div key={`empty-${dayIndex}`} className="aspect-square" />;
                        const level = day.tokens > 0 ? Math.min(4, Math.ceil((day.tokens / maximum) * 4)) : 0;
                        return (
                          <button
                            key={day.date}
                            ref={(element) => { if (element) buttons.current.set(day.date, element); else buttons.current.delete(day.date); }}
                            type="button"
                            className={`aspect-square min-w-0 rounded-[3px] border transition-colors hover:ring-2 hover:ring-text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${LEVELS[level]}`}
                            aria-label={`${formatTokens(day.tokens)} tokens on ${formatDate(day.date)}`}
                            aria-describedby={tooltip?.date === day.date ? tooltipId : undefined}
                            tabIndex={day.date === (focusedDate || data.days[data.days.length - 1].date) ? 0 : -1}
                            onMouseEnter={(event) => showTooltip(event, day)}
                            onMouseLeave={() => setTooltip(null)}
                            onFocus={(event) => { setFocusedDate(day.date); showTooltip(event, day); }}
                            onBlur={() => setTooltip(null)}
                            onClick={(event) => showTooltip(event, day)}
                            onKeyDown={(event) => handleKeyDown(event, day)}
                          />
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-text-muted">
            <span>{activeDays ? `${activeDays} active ${activeDays === 1 ? "day" : "days"}` : "No token usage recorded yet"} · Input + output, including cached input</span>
            <div className="flex items-center gap-1.5" aria-label="Color intensity increases with daily token consumption">
              <span className="mr-1">Less</span>
              {LEVELS.map((color, index) => <span key={index} className={`size-3 rounded-[3px] border ${color}`} aria-hidden="true" />)}
              <span className="ml-1">More</span>
            </div>
          </div>
          <p className="text-[11px] text-text-muted">
            All providers · Daily totals in {data.timeZone} · Independent of the period filter
            {error && " · Refresh failed; showing last loaded data"}
          </p>
        </>
      )}
      {selectedDay && createPortal(
        <div id={tooltipId} role="tooltip" className="pointer-events-none fixed z-[100] w-[264px] rounded-lg border border-border-subtle bg-surface px-3 py-2 text-center text-xs text-text-main shadow-lg" style={{ left: tooltip.left, top: tooltip.top, transform: `translate(-50%, ${tooltip.above ? "-100%" : "0"})` }}>
          <div className="font-semibold">{formatTokens(selectedDay.tokens)} tokens consumed</div>
          <div className="mt-1 text-text-muted">{formatDate(selectedDay.date)}</div>
        </div>,
        document.body
      )}
    </Card>
  );
}
