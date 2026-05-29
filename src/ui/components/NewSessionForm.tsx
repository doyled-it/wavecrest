import { useEffect, useMemo, useState } from "react";
import type { Session } from "../../types.ts";
import { FolderPicker } from "./FolderPicker.tsx";

export function NewSessionForm({ sessions }: { sessions: Session[] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [cwd, setCwd] = useState("");
  const [worktree, setWorktree] = useState(true);
  const [newTab, setNewTab] = useState(true);
  const [agent, setAgent] = useState<"claude">("claude");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [keystrokeStep, setKeystrokeStep] = useState<{ beforeTabIds: string[]; payload: Record<string, unknown> } | null>(null);

  const recentCwds = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) if (s.cwd) set.add(s.cwd);
    return Array.from(set);
  }, [sessions]);

  // Filter out junk recents (the usage-poller meta-process lives in /tmp).
  const usefulCwds = useMemo(
    () => recentCwds.filter(c => !c.startsWith("/tmp") && !c.startsWith("/private/tmp")),
    [recentCwds],
  );

  useEffect(() => {
    if (open && !cwd && usefulCwds.length > 0) setCwd(usefulCwds[0]!);
  }, [open, cwd, usefulCwds]);

  const toggle = () => {
    setOpen(v => !v);
    setErr(null);
  };

  const payloadFromForm = () => ({
    branch: branch.trim(),
    display_name: name.trim() || undefined,
    cwd: cwd.trim() || undefined,
    worktree,
    agent,
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!branch.trim()) { setErr("branch is required"); return; }
    setBusy(true); setErr(null);
    try {
      if (newTab) {
        // Two-step: snapshot tabs, ask user to press Cmd+T, then finalize.
        const r = await fetch("/api/open/snapshot", { method: "POST" });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
        setKeystrokeStep({ beforeTabIds: data.tabIds ?? [], payload: payloadFromForm() });
      } else {
        const r = await fetch("/api/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payloadFromForm(), new_tab: false }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
        setBranch(""); setName(""); setOpen(false);
      }
    } catch (e: unknown) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finalize = async () => {
    if (!keystrokeStep) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/open/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...keystrokeStep.payload, beforeTabIds: keystrokeStep.beforeTabIds }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      setBranch(""); setName(""); setOpen(false); setKeystrokeStep(null);
    } catch (e: unknown) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return <button className="new-toggle" onClick={toggle} type="button">+ new session</button>;
  }

  if (keystrokeStep) {
    return (
      <div className="new-form">
        <div style={{ fontSize: 12, lineHeight: 1.5 }}>
          Press <kbd style={{ background: "var(--bg)", padding: "2px 6px", borderRadius: 3, fontFamily: "ui-monospace, monospace", border: "1px solid var(--muted)" }}>⌘T</kbd> in Wave to open a new tab, then click <b>Continue</b>.
          {err ? <div className="new-err">{err}</div> : null}
        </div>
        <div className="new-row new-controls" style={{ marginTop: 8 }}>
          <div className="spacer" />
          <button type="button" onClick={() => { setKeystrokeStep(null); setErr(null); }} disabled={busy}>cancel</button>
          <button type="button" onClick={finalize} disabled={busy}>{busy ? "detecting..." : "continue"}</button>
        </div>
      </div>
    );
  }

  return (
    <form className="new-form" onSubmit={submit}>
      <div className="new-row">
        <input
          autoFocus
          placeholder="display name (optional — defaults to branch)"
          value={name}
          onChange={e => setName(e.target.value)}
        />
      </div>
      <div className="new-row">
        <input
          placeholder="branch name (e.g. feat/oauth)"
          value={branch}
          onChange={e => setBranch(e.target.value)}
        />
      </div>
      <div className="new-row">
        <input
          list="recent-cwds"
          placeholder="cwd"
          value={cwd}
          onChange={e => setCwd(e.target.value)}
        />
        <button type="button" onClick={() => setPicking(true)} title="browse for folder">📁</button>
        <datalist id="recent-cwds">
          {usefulCwds.map(c => <option key={c} value={c} />)}
        </datalist>
      </div>
      {picking ? (
        <FolderPicker
          initial={cwd || undefined}
          onPick={p => { setCwd(p); setPicking(false); }}
          onCancel={() => setPicking(false)}
        />
      ) : null}
      <div className="new-row new-controls">
        <label>
          <input type="checkbox" checked={worktree} onChange={e => setWorktree(e.target.checked)} />
          worktree
        </label>
        <label>
          <input type="checkbox" checked={newTab} onChange={e => setNewTab(e.target.checked)} />
          new tab
        </label>
        <select value={agent} onChange={e => setAgent(e.target.value as "claude")}>
          <option value="claude">claude</option>
        </select>
        <div className="spacer" />
        <button type="button" onClick={toggle} disabled={busy}>cancel</button>
        <button type="submit" disabled={busy}>{busy ? "..." : "open"}</button>
      </div>
      {err ? <div className="new-err">{err}</div> : null}
    </form>
  );
}
