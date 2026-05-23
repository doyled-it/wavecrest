import { GaugeRail } from "./components/GaugeRail.tsx";
import { SessionGrid } from "./components/SessionGrid.tsx";
import { useApi } from "./api.ts";
import type { Session, TokenRollup, UsageSnapshot } from "../types.ts";

export function App() {
  const sessions = useApi<Array<Session & { rollup: TokenRollup | null }>>("/api/sessions", []);
  const usage    = useApi<{ claude: UsageSnapshot[] }>("/api/usage", { claude: [] });
  return (
    <div className="app">
      <GaugeRail usage={usage.claude} />
      <SessionGrid sessions={sessions} />
    </div>
  );
}
