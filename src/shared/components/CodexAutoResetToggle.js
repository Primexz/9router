"use client";

import { useEffect, useState } from "react";
import { Tooltip } from "@/shared/components";

export function useCodexAutoReset() {
  const [config, setConfig] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load auto-reset settings");
        const settings = await response.json();
        setConfig(settings.codexAutoReset || {});
      })
      .catch((error) => setError(error.message));
  }, []);

  async function toggle(id) {
    if (busy || config === null) return;
    const previous = config;
    const enabled = config.connections?.[id] !== true;
    setBusy(true);
    setError("");
    setConfig({ ...config, connections: { ...config.connections, [id]: enabled } });
    try {
      const response = await fetch("/api/settings", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load auto-reset settings");
      const settings = await response.json();
      const next = {
        ...settings.codexAutoReset,
        connections: { ...settings.codexAutoReset?.connections, [id]: enabled },
      };
      const saved = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codexAutoReset: next }),
      });
      if (!saved.ok) throw new Error("Could not save auto-reset settings");
      setConfig(next);
    } catch (error) {
      setConfig(previous);
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return { config, busy, error, toggle };
}

export default function CodexAutoResetToggle({ connection, control }) {
  if (connection.provider !== "codex" || !["oauth", "access_token"].includes(connection.authType)) return null;
  const enabled = control.config?.connections?.[connection.id] === true;
  return (
    <span className="inline-flex flex-col items-center">
      <Tooltip text="Automatically use a reset within 15 minutes of expiry when quota has been used.">
        <button
          type="button"
          role="switch"
          aria-label="Auto-apply expiring resets"
          aria-checked={enabled}
          disabled={control.busy || control.config === null}
          onClick={() => control.toggle(connection.id)}
          className={`flex flex-col items-center rounded px-2 py-1 text-[10px] transition-colors hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50 ${enabled ? "text-primary" : "text-text-muted"}`}
        >
          <span className="material-symbols-outlined text-[18px]">{enabled ? "toggle_on" : "toggle_off"}</span>
          <span>Auto-reset</span>
        </button>
      </Tooltip>
      {control.error && <span role="alert" className="max-w-40 text-xs text-red-500">{control.error}</span>}
    </span>
  );
}
