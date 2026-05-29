import { useEffect } from "react";
import { GaugeRail } from "./components/GaugeRail.tsx";
import { SessionGrid } from "./components/SessionGrid.tsx";
import { NewSessionForm } from "./components/NewSessionForm.tsx";
import { ActivityFeed } from "./components/ActivityFeed.tsx";
import { useApi } from "./api.ts";
import type { Session, TokenRollup, UsageSnapshot } from "../types.ts";

interface Palette {
  bg: string; fg: string; card: string; muted: string;
  ok: string; warn: string; bad: string; accent: string;
}

export function App() {
  const sessions = useApi<Array<Session & { rollup: TokenRollup | null }>>("/api/sessions", []);
  const usage    = useApi<{ claude: UsageSnapshot[] }>("/api/usage", { claude: [] });
  const theme    = useApi<{ palette: Palette | null }>("/api/theme", { palette: null });

  useEffect(() => {
    const p = theme.palette;
    if (!p) return;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(p)) {
      if (typeof v === "string") root.style.setProperty(`--${k}`, v);
    }
  }, [theme.palette]);

  return (
    <div className="app">
      <GaugeRail usage={usage.claude} />
      <div className="main">
        <NewSessionForm sessions={sessions} />
        <SessionGrid sessions={sessions} />
        <ActivityFeed />
      </div>
    </div>
  );
}
