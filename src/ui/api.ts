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
    return () => { cancelled = true; sse.close(); };
  }, [path]);
  return data;
}
