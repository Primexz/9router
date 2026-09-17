"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import useSettingsStore from "@/store/settingsStore";
import { DEFAULT_TIME_ZONE, getAvailableTimeZones } from "@/shared/utils/timeZone";

function timeZoneLabel(timeZone) {
  return timeZone === DEFAULT_TIME_ZONE ? "UTC" : timeZone.replaceAll("_", " ");
}

function currentOffset(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value || "";
  } catch {
    return "";
  }
}

export default function TimeZoneSelector() {
  const settings = useSettingsStore((state) => state.settings);
  const fetchSettings = useSettingsStore((state) => state.fetchSettings);
  const patchSettings = useSettingsStore((state) => state.patchSettings);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const timeZones = useMemo(() => getAvailableTimeZones(), []);
  const selected = settings?.timeZone || DEFAULT_TIME_ZONE;
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return search
      ? timeZones.filter((timeZone) => timeZoneLabel(timeZone).toLowerCase().includes(search))
      : timeZones;
  }, [query, timeZones]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    function closeOnOutsideClick(event) {
      if (dialogRef.current && !dialogRef.current.contains(event.target)) setOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  async function selectTimeZone(timeZone) {
    if (timeZone === selected || saving) {
      setOpen(false);
      return;
    }
    setSaving(true);
    const updated = await patchSettings({ timeZone });
    setSaving(false);
    if (updated) {
      setOpen(false);
      setQuery("");
      window.dispatchEvent(new CustomEvent("timezonechange", { detail: timeZone }));
    }
  }

  return (
    <>
      <button
        type="button"
        className="hidden md:flex max-w-[190px] items-center gap-1.5 h-8 rounded-lg border border-border bg-surface/60 px-2 text-text-muted transition-colors hover:border-primary/40 hover:bg-surface disabled:opacity-60"
        title="Display timezone"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!settings}
        onClick={() => setOpen(true)}
      >
        <span className="material-symbols-outlined text-[17px]" aria-hidden="true">public</span>
        <span className="truncate text-xs text-text-main">{timeZoneLabel(selected)}</span>
        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">expand_more</span>
      </button>

      {open && createPortal(
        <div className="fixed inset-0 z-[90] flex items-start justify-center bg-black/30 p-4 pt-[10vh] backdrop-blur-sm" role="presentation">
          <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="timezone-title" className="flex max-h-[72vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-black/10 bg-surface shadow-2xl dark:border-white/10 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
              <div>
                <h2 id="timezone-title" className="font-semibold text-text-main">Select timezone</h2>
                <p className="mt-0.5 text-xs text-text-muted">Dates and metrics use this timezone.</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-text-muted transition-colors hover:bg-black/5 hover:text-text-main dark:hover:bg-white/5" aria-label="Close">
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>

            <div className="border-b border-border-subtle p-3">
              <div className="relative">
                <span className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-text-muted">search</span>
                <input ref={inputRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search city or region…" className="h-10 w-full rounded-lg border border-border bg-bg pl-10 pr-9 text-sm text-text-main outline-none transition-colors placeholder:text-text-muted focus:border-primary/60 focus:ring-2 focus:ring-primary/15" />
                {query && <button type="button" onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-text-muted hover:text-text-main" aria-label="Clear search"><span className="material-symbols-outlined text-[16px]">close</span></button>}
              </div>
            </div>

            <div className="custom-scrollbar flex-1 overflow-y-auto p-2" role="listbox" aria-label="Timezones">
              {filtered.map((timeZone) => {
                const active = timeZone === selected;
                return (
                  <button key={timeZone} type="button" role="option" aria-selected={active} disabled={saving} onClick={() => selectTimeZone(timeZone)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${active ? "bg-primary/10 text-primary" : "text-text-main hover:bg-black/5 dark:hover:bg-white/5"} ${saving ? "cursor-wait opacity-60" : ""}`}>
                    <span className={`material-symbols-outlined text-[18px] ${active ? "text-primary" : "text-text-muted"}`}>{active ? "check_circle" : "schedule"}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{timeZoneLabel(timeZone)}</span>
                    <span className="shrink-0 text-xs tabular-nums text-text-muted">{currentOffset(timeZone)}</span>
                  </button>
                );
              })}
              {!filtered.length && <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-text-muted"><span className="material-symbols-outlined text-3xl">travel_explore</span><span>No timezone found</span></div>}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
