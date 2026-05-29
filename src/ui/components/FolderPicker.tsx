import { useEffect, useState } from "react";

interface BrowseEntry { name: string; isDir: boolean; isGitRepo: boolean; }
interface BrowseResult { path: string; parent: string | null; entries: BrowseEntry[]; }

export function FolderPicker({ initial, onPick, onCancel }: {
  initial?: string;
  onPick: (path: string) => void;
  onCancel: () => void;
}) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async (path: string | undefined) => {
    setErr(null);
    try {
      // Default to ~ when no path is given (server treats missing param as homedir).
      const target = path && path.trim() && !path.startsWith("/tmp") && !path.startsWith("/private/tmp")
        ? path : undefined;
      const r = await fetch(`/api/browse?${target ? `path=${encodeURIComponent(target)}` : ""}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setData(d);
    } catch (e: unknown) {
      setErr((e as Error).message);
    }
  };

  useEffect(() => { load(initial); }, [initial]);

  if (err) return <div className="picker"><div className="picker-err">{err}</div><button onClick={onCancel}>close</button></div>;
  if (!data) return <div className="picker">loading...</div>;

  const segments = data.path.split("/").filter(Boolean);
  return (
    <div className="picker">
      <div className="picker-bar">
        <button onClick={() => data.parent && load(data.parent)} disabled={!data.parent} title="up">↑</button>
        <div className="picker-crumbs">
          <span className="crumb" onClick={() => load("/")}>/</span>
          {segments.map((seg, i) => {
            const upto = "/" + segments.slice(0, i + 1).join("/");
            return <span key={upto}><span className="crumb" onClick={() => load(upto)}>{seg}</span>{i < segments.length - 1 ? <span className="sep">/</span> : null}</span>;
          })}
        </div>
      </div>
      <div className="picker-list">
        {data.entries.length === 0 ? <div className="picker-empty">(no subdirectories)</div> : null}
        {data.entries.map(e => (
          <div key={e.name} className={`picker-item ${e.isGitRepo ? "is-repo" : ""}`} onDoubleClick={() => load(`${data.path}/${e.name}`)}>
            <span className="picker-name" onClick={() => load(`${data.path}/${e.name}`)}>
              {e.isGitRepo ? "⎇ " : "📁 "}{e.name}
            </span>
          </div>
        ))}
      </div>
      <div className="picker-actions">
        <div className="picker-current" title={data.path}>{data.path}</div>
        <button onClick={onCancel}>cancel</button>
        <button className="primary" onClick={() => onPick(data.path)}>use this folder</button>
      </div>
    </div>
  );
}
