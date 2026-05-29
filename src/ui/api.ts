import { useEffect, useState } from "react";

export function useApi<T>(path: string, initial: T): T {
  const [data, setData] = useState<T>(initial);
  useEffect(() => {
    let cancelled = false;
    const reload = () => fetch(path).then(r => r.json()).then(d => { if (!cancelled) setData(d); }).catch(() => {});

    reload();
    const sse = new EventSource("/api/events");
    sse.onopen = () => reload();
    sse.addEventListener("session", reload);
    sse.addEventListener("rollup", reload);
    sse.addEventListener("usage", reload);

    // Safety net #1: refetch whenever the tab regains focus. EventSource often dies
    // silently after sleep / network drops / daemon restarts without firing onerror,
    // so we force a fresh read whenever the user comes back to the dashboard.
    const onVisible = () => { if (!document.hidden) reload(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", reload);

    // Safety net #2: periodic poll. Catches the case where the tab is left open
    // for hours with broken SSE and the user just glances at it without focusing.
    const poll = setInterval(reload, 30_000);

    return () => {
      cancelled = true;
      sse.close();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", reload);
      clearInterval(poll);
    };
  }, [path]);
  return data;
}
