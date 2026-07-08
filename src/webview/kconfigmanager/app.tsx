import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KconfigRpc, getVsCodeApi, loadPersistedState, savePersistedState } from './rpc';
import { KcStore, compileQuery, type FlatRow, type CompiledQuery } from './store';
import type {
  KcNode, KcNodeInfo, KcTarget, KcExprLine, KcChange, KcDriftEntry, NodeId, Tri, KcDeltaSet,
} from '../../utils/kconfig/kconfigRpcTypes';

interface DriftOverlayState {
  target: 'prj' | 'fragment';
  targetPath: string;
  entries: KcDriftEntry[];
  missingFragments: string[];
  stale: boolean;
  staleReason?: string;
}

const ROW_H = 24;
const OVERSCAN = 8;

type Phase = 'starting' | 'configuring' | 'ready' | 'error' | 'crashed';

interface PersistedUi {
  showAll: boolean;
  showName: boolean;
  expanded: string[];
  selectionKey?: string;
  infoWidth: number;
}

const rpc = new KconfigRpc(getVsCodeApi());

export function App() {
  const [phase, setPhase] = useState<Phase>('starting');
  const [phaseMsg, setPhaseMsg] = useState<string>('');
  const [target, setTarget] = useState<KcTarget | undefined>();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [changeCount, setChangeCount] = useState(0);

  const storeRef = useRef<KcStore | undefined>(undefined);
  // Single revision counter: bumped on any in-place mutation of the store or expansion
  // set, so memoized derivations (flat rows) recompute even though refs stay stable.
  const [rev, setRev] = useState(0);
  const bump = useCallback(() => setRev((v) => v + 1), []);

  const persisted = useRef<PersistedUi>({
    showAll: false, showName: false, expanded: [], infoWidth: 360,
    ...loadPersistedState<PersistedUi>(),
  } as PersistedUi);

  const [showAll, setShowAll] = useState(persisted.current.showAll);
  const [showName, setShowName] = useState(persisted.current.showName);
  const expandedRef = useRef<Set<string>>(new Set(persisted.current.expanded));
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<NodeId | null>(null);
  const [info, setInfo] = useState<KcNodeInfo | undefined>();
  const [jumpOpen, setJumpOpen] = useState(false);
  const [infoWidth, setInfoWidth] = useState(persisted.current.infoWidth);
  const [changes, setChanges] = useState<KcChange[]>([]);
  const [changesOpen, setChangesOpen] = useState(false);
  const [drift, setDrift] = useState<DriftOverlayState | undefined>();
  const [exportError, setExportError] = useState<string | undefined>();
  const [tempCount, setTempCount] = useState(0);
  const [tempStale, setTempStale] = useState(false);

  const persist = useCallback(() => {
    const p: PersistedUi = {
      showAll, showName, infoWidth,
      expanded: Array.from(expandedRef.current),
      selectionKey: selected !== null ? storeRef.current?.key(selected) : undefined,
    };
    savePersistedState(p);
  }, [showAll, showName, infoWidth, selected]);

  useEffect(() => { persist(); }, [persist]);

  // --- boot / events -------------------------------------------------------
  useEffect(() => {
    const off = rpc.onEvent((e) => {
      if (e.kind === 'phase') {
        setPhase(e.phase);
        setPhaseMsg(e.message ?? '');
        if (e.phase === 'ready') { void loadTree(); }
      } else if (e.kind === 'warnings') {
        // Deduplicate: the backend can surface the same advisory more than once.
        setWarnings((w) => Array.from(new Set([...w, ...e.warnings])).slice(-200));
      } else if (e.kind === 'dirty') {
        setDirty(e.dirty);
      } else if (e.kind === 'reloaded') {
        storeRef.current = new KcStore(e.init);
        setDirty(e.init.dirty);
        setWarnings(e.init.warnings ?? []);
        void refreshChangeCount();
        bump();
      } else if (e.kind === 'reloading') {
        setPhaseMsg('Reloading…');
      } else if (e.kind === 'externalChange' && e.hasLocalEdits) {
        // The on-disk .config changed while we have unsaved edits. Surface it; the user
        // can Open to reload or keep editing. (Silent reload happens host-side when clean.)
        setPhaseMsg('The .config changed on disk. Your unsaved edits are kept; use Open to reload from disk.');
      } else if (e.kind === 'driftReady') {
        setDrift({
          target: e.target,
          targetPath: e.targetPath,
          entries: e.drift,
          missingFragments: e.missingFragments,
          stale: e.stale,
          staleReason: e.staleReason,
        });
      } else if (e.kind === 'driftError') {
        setExportError(e.message);
      }
    });
    rpc.ready();
    return off;
  }, []);

  const loadTree = useCallback(async () => {
    try {
      const [t, tree] = await Promise.all([rpc.call('kconfig/getTarget'), rpc.call('kconfig/getTree')]);
      setTarget(t);
      setWarnings(tree.warnings);
      storeRef.current = new KcStore(tree);
      setDirty(tree.dirty);
      // Restore selection by key.
      const selKey = persisted.current.selectionKey;
      if (selKey) {
        for (const n of storeRef.current.nodes.values()) {
          if (n.key === selKey) { setSelected(n.id); break; }
        }
      }
      await refreshChangeCount();
      bump();
    } catch (e) {
      setPhase('error');
      setPhaseMsg(String(e));
    }
  }, []);

  const refreshChangeCount = useCallback(async () => {
    try {
      const res = await rpc.call('kconfig/getChanges');
      setChanges(res.changes);
      setChangeCount(res.changes.length);
    } catch { /* ignore */ }
  }, []);

  // Instant hover help: native title tooltips are slow and easy to miss in a webview,
  // so every control carries data-tip and one delegated listener shows a styled tooltip
  // after a short delay.
  const [tip, setTip] = useState<{ text: string; x: number; y: number; above: boolean } | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    let currentEl: HTMLElement | null = null;
    const hide = () => {
      if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; }
      currentEl = null;
      setTip(null);
    };
    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-tip]') as HTMLElement | null;
      if (!el) { hide(); return; }
      if (el === currentEl) { return; }
      hide();
      currentEl = el;
      const text = el.getAttribute('data-tip');
      if (!text) { return; }
      timer = window.setTimeout(() => {
        const r = el.getBoundingClientRect();
        const x = Math.min(Math.max(r.left + r.width / 2, 12), window.innerWidth - 12);
        const above = r.bottom + 60 > window.innerHeight;
        setTip({ text, x, y: above ? r.top - 6 : r.bottom + 6, above });
      }, 250);
    };
    document.addEventListener('mouseover', onOver);
    document.addEventListener('mousedown', hide, true);
    document.addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mousedown', hide, true);
      document.removeEventListener('scroll', hide, true);
    };
  }, []);
  const tipEl = tip
    ? <div className={`kc-tooltip ${tip.above ? 'above' : ''}`} style={{ left: tip.x, top: tip.y }}>{tip.text}</div>
    : null;

  // Temporary-values badge: recompute quietly a moment after the state settles
  // (edits, saves, reloads), so the user can see there is something to export
  // without pressing the export button.
  useEffect(() => {
    if (phase !== 'ready') { return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await rpc.call('kconfig/getDriftCount');
        // count -1 means a refresh was already in flight; keep the previous value.
        if (!cancelled && res.count >= 0) { setTempCount(res.count); setTempStale(res.stale); }
      } catch { /* ignore */ }
    }, 1200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [phase, rev, dirty]);

  // --- mutations -----------------------------------------------------------
  const applyDelta = useCallback((delta: KcDeltaSet) => {
    storeRef.current?.applyDelta(delta);
    setDirty(delta.dirty);
    void refreshChangeCount();
    bump();
  }, [refreshChangeCount, bump]);

  const setValue = useCallback(async (id: NodeId, value: string) => {
    const gen = storeRef.current?.generation ?? 0;
    try {
      const res = await rpc.call('kconfig/setValue', { generation: gen, id, value });
      if (res.ok) { applyDelta(res as unknown as KcDeltaSet); }
      else { setPhaseMsg(res.error); }
      return res;
    } catch (e) { setPhaseMsg(String(e)); return { ok: false as const, error: String(e) }; }
  }, [applyDelta]);

  const cycleTri = useCallback((node: KcNode) => {
    if (node.assignable.length < 2) { return; }
    const idx = node.assignable.indexOf(node.triValue);
    const nextTri = node.assignable[(idx + 1) % node.assignable.length];
    void setValue(node.id, triStr(nextTri));
  }, [setValue]);

  const directSet = useCallback((node: KcNode, tri: Tri) => {
    if (node.assignable.includes(tri)) { void setValue(node.id, triStr(tri)); }
  }, [setValue]);

  const undo = useCallback(async () => {
    const res = await rpc.call('kconfig/undo');
    if (res.ok) { applyDelta(res as unknown as KcDeltaSet); }
  }, [applyDelta]);
  const redo = useCallback(async () => {
    const res = await rpc.call('kconfig/redo');
    if (res.ok) { applyDelta(res as unknown as KcDeltaSet); }
  }, [applyDelta]);
  const revert = useCallback(async (name: string) => {
    const res = await rpc.call('kconfig/revert', { name });
    if (res.ok) { applyDelta(res as unknown as KcDeltaSet); }
  }, [applyDelta]);

  // --- info ----------------------------------------------------------------
  useEffect(() => {
    if (selected === null) { setInfo(undefined); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const i = await rpc.call('kconfig/getInfo', { id: selected });
        if (!cancelled) { setInfo(i); }
      } catch { /* ignore */ }
    }, 60);
    return () => { cancelled = true; clearTimeout(t); };
  }, [selected, rev]);

  // --- expansion / navigation ---------------------------------------------
  const toggleExpand = useCallback((node: KcNode) => {
    const s = expandedRef.current;
    if (s.has(node.key)) { s.delete(node.key); } else { s.add(node.key); }
    persist();
    bump();
  }, [bump, persist]);

  const expandAncestors = useCallback((id: NodeId) => {
    const store = storeRef.current;
    if (!store) { return; }
    for (const a of store.ancestors(id)) {
      const k = store.key(a);
      if (k) { expandedRef.current.add(k); }
    }
  }, []);

  const revealAndSelect = useCallback((id: NodeId) => {
    const store = storeRef.current;
    if (!store) { return; }
    const node = store.get(id);
    if (node && !node.visible && !showAll) { setShowAll(true); }
    expandAncestors(id);
    setSelected(id);
    bump();
  }, [expandAncestors, showAll, bump]);

  // --- flat rows -----------------------------------------------------------
  const store = storeRef.current;
  const query: CompiledQuery = useMemo(() => compileQuery(filter), [filter]);
  const rows: FlatRow[] = useMemo(() => {
    if (!store) { return []; }
    if (filter.trim()) { return store.flattenFiltered(query, showAll); }
    return store.flattenFull({ showAll, expanded: expandedRef.current });
    // `rev` captures in-place store/expansion mutations that refs alone would hide.
  }, [store, filter, query, showAll, rev]);

  // --- save / load ---------------------------------------------------------
  const save = useCallback(async (kind: 'config' | 'as' | 'minimal') => {
    const res = await rpc.call('kconfig/save', { kind });
    if (res.message) { setPhaseMsg(res.message); }
    if (typeof res.dirty === 'boolean') { setDirty(res.dirty); }
  }, []);
  const open = useCallback(async () => {
    const res = await rpc.call('kconfig/loadConfig', {});
    if (res.canceled) { return; }
    if (res.changes) { applyDelta({ generation: res.generation ?? 0, changes: res.changes, dirty: res.dirty ?? false }); }
    if (res.message) { setPhaseMsg(res.message); }
  }, [applyDelta]);
  const startExport = useCallback(async (target: 'prj' | 'fragment') => {
    setExportError(undefined);
    try {
      await rpc.call('kconfig/persistPrjConf', { target });
      // The panel replies with a driftReady (or driftError) event.
    } catch (e) {
      setExportError(String(e));
    }
  }, []);

  const writeExport = useCallback(async (lines: string[]) => {
    setDrift(undefined);
    try {
      await rpc.call('kconfig/persistPrjConfWrite', { lines });
      // Confirmation is shown as a VS Code notification by the panel.
    } catch (e) {
      setExportError(String(e));
    }
  }, []);

  // --- keyboard ------------------------------------------------------------
  const onTreeKey = useCallback((e: React.KeyboardEvent) => {
    if (!store) { return; }
    const idx = rows.findIndex((r) => r.id === selected);
    const move = (delta: number) => {
      const ni = Math.max(0, Math.min(rows.length - 1, (idx < 0 ? 0 : idx) + delta));
      setSelected(rows[ni]?.id ?? null);
      e.preventDefault();
    };
    const node = selected !== null ? store.get(selected) : undefined;
    switch (e.key) {
      case 'ArrowDown': case 'j': move(1); break;
      case 'ArrowUp': case 'k': move(-1); break;
      case 'PageDown': move(15); break;
      case 'PageUp': move(-15); break;
      case 'Home': setSelected(rows[0]?.id ?? null); e.preventDefault(); break;
      case 'End': setSelected(rows[rows.length - 1]?.id ?? null); e.preventDefault(); break;
      case ' ': if (node) { onPrimary(node); e.preventDefault(); } break;
      case 'Enter': case 'ArrowRight': case 'l': if (node) { onEnter(node); e.preventDefault(); } break;
      case 'ArrowLeft': case 'h': if (node) { onLeave(node); e.preventDefault(); } break;
      case 'n': if (node) { directSet(node, 0); } break;
      case 'm': if (node) { directSet(node, 1); } break;
      case 'y': if (node) { directSet(node, 2); } break;
      case '/': setJumpOpen(true); e.preventDefault(); break;
      case 'A': setShowAll((v) => !v); break;
      case 'C': setShowName((v) => !v); break;
      case 's': if (!e.ctrlKey && !e.metaKey) { void save('config'); } break;
      case 'S': void save('as'); break;
      case 'd': void save('minimal'); break;
      case 'o': void open(); break;
      default: break;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { void undo(); e.preventDefault(); }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { void redo(); e.preventDefault(); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') { setJumpOpen(true); e.preventDefault(); }
  }, [store, rows, selected, directSet, undo, redo, save, open]);

  const onPrimary = useCallback((node: KcNode) => {
    // Space: toggle if changeable, else enter/expand.
    if (isToggleable(node)) { primaryToggle(node); }
    else { onEnter(node); }
  }, []);
  const onEnter = useCallback((node: KcNode) => {
    if (node.children.length) { if (!expandedRef.current.has(node.key)) { toggleExpand(node); } else if (isToggleable(node)) { primaryToggle(node); } }
    else if (isToggleable(node)) { primaryToggle(node); }
  }, [toggleExpand]);
  const onLeave = useCallback((node: KcNode) => {
    if (expandedRef.current.has(node.key)) { toggleExpand(node); }
    else if (node.parent !== null) { setSelected(node.parent); }
  }, [toggleExpand]);

  const primaryToggle = useCallback((node: KcNode) => {
    if (node.type === 'bool' || node.type === 'tristate') {
      if (node.isYModeChoiceSym) { void setValue(node.id, 'y'); }
      else { cycleTri(node); }
    }
    // string/int/hex handled inline in the row (edit affordance)
  }, [cycleTri, setValue]);

  // --- render --------------------------------------------------------------
  if (phase !== 'ready' || !store) {
    return <>
      <BootScreen phase={phase} message={phaseMsg} onRetry={() => rpc.call('kconfig/restart')} />
      {tipEl}
    </>;
  }

  return (
    <div className="kc-app" onKeyDown={onTreeKey}>
      <Toolbar
        dirty={dirty} changeCount={changeCount} changesOpen={changesOpen}
        tempCount={tempCount} tempStale={tempStale}
        showAll={showAll} showName={showName} filter={filter}
        onFilter={setFilter}
        onToggleShowAll={() => setShowAll((v) => !v)}
        onToggleShowName={() => setShowName((v) => !v)}
        onToggleChanges={() => setChangesOpen((v) => !v)}
        onJump={() => setJumpOpen(true)}
        onSave={() => save('config')} onSaveAs={() => save('as')} onSaveMin={() => save('minimal')} onOpen={open}
        onUndo={undo} onRedo={redo}
        onPersistPrj={() => startExport('prj')} onPersistFragment={() => startExport('fragment')}
        onBuild={() => rpc.call('kconfig/buildNow')}
      />
      {exportError && (
        <div className="kc-banner-warn">
          {exportError}
          <button className="kc-btn kc-banner-dismiss" data-tip="Dismiss" onClick={() => setExportError(undefined)}>
            <span className="codicon codicon-close" />
          </button>
        </div>
      )}
      <PathBar
        store={store} selected={selected}
        onSelectNode={(id) => { if (id === null) { setSelected(null); } else { revealAndSelect(id); } }}
      />
      {target?.envSource === 'fallback' && (
        <div className="kc-banner-warn">
          Kconfig environment reconstructed from the CMake cache (build.ninja was not usable): values may differ slightly from a real build. Build the project once for exact fidelity.
        </div>
      )}
      {changesOpen && (
        <ChangesPanel changes={changes} onJump={revealAndSelect} onRevert={revert}
          onClose={() => setChangesOpen(false)} />
      )}
      <div className="kc-body">
        <VirtualTree
          store={store} rows={rows} selected={selected} showName={showName}
          onSelect={setSelected}
          onToggleExpand={toggleExpand}
          onPrimary={onPrimary}
          onEnter={onEnter}
          onSetValue={setValue}
          onDirectSet={directSet}
          onCycle={cycleTri}
          expanded={expandedRef.current}
          onKeyDown={onTreeKey}
          hasShownChildren={(id) => store.hasShownChildren(id, showAll)}
        />
        <div className="kc-splitter" onMouseDown={startResize(setInfoWidth)} />
        <InfoPane info={info} width={infoWidth} onNavigate={revealAndSelect}
          onOpenLocation={(file, line) => rpc.call('kconfig/openLocation', { file, line })} />
      </div>
      <StatusBar store={store} rows={rows} dirty={dirty} warnings={warnings} />
      {jumpOpen && (
        <JumpTo store={store} onClose={() => setJumpOpen(false)}
          onJump={(id) => { setJumpOpen(false); revealAndSelect(id); }}
          onSetValue={setValue} onDirectSet={directSet} onCycle={cycleTri} showName={showName} />
      )}
      {drift && (
        <DriftOverlay state={drift} dirty={dirty}
          onCancel={() => setDrift(undefined)}
          onJump={(id) => { setDrift(undefined); revealAndSelect(id); }}
          onWrite={writeExport} />
      )}
      {tipEl}
    </div>
  );
}

// ===========================================================================
// Sub-components
// ===========================================================================

function BootScreen({ phase, message, onRetry }: { phase: Phase; message: string; onRetry: () => void }) {
  const label = phase === 'configuring' ? 'Configuring project (CMake)…'
    : phase === 'starting' ? 'Starting Kconfig server…'
      : phase === 'error' ? 'Error' : phase === 'crashed' ? 'Server stopped' : 'Loading…';
  return (
    <div className="kc-boot">
      <div className={`kc-boot-title ${phase === 'error' || phase === 'crashed' ? 'kc-boot-error' : ''}`}>{label}</div>
      {message && <pre className="kc-boot-msg">{message}</pre>}
      {(phase === 'error' || phase === 'crashed') && (
        <button className="kc-btn" onClick={onRetry}>Retry</button>
      )}
    </div>
  );
}

function Toolbar(p: {
  dirty: boolean; changeCount: number; changesOpen: boolean;
  tempCount: number; tempStale: boolean;
  showAll: boolean; showName: boolean; filter: string;
  onFilter: (v: string) => void; onToggleShowAll: () => void; onToggleShowName: () => void;
  onToggleChanges: () => void; onJump: () => void;
  onSave: () => void; onSaveAs: () => void; onSaveMin: () => void; onOpen: () => void;
  onUndo: () => void; onRedo: () => void; onPersistPrj: () => void; onPersistFragment: () => void; onBuild: () => void;
}) {
  return (
    <div className="kc-toolbar">
      <div className="kc-toolbar-row">
        <div className="kc-search" data-tip="Filter the tree as you type. Space separates terms that must all match (regex allowed).">
          <span className="codicon codicon-search" />
          <input placeholder="Filter tree…" value={p.filter} onChange={(e) => p.onFilter(e.target.value)} />
        </div>
        <button className="kc-btn" data-tip="Jump to a symbol by name or prompt (shortcut: / or Ctrl+F)" onClick={p.onJump}><span className="codicon codicon-target" /></button>
        <Toggle on={p.showName} label="name" title="Show the CONFIG_ symbol names next to prompts (shortcut: C)" onClick={p.onToggleShowName} />
        <Toggle on={p.showAll} label="all" title="Also show invisible options, dimmed (shortcut: A)" onClick={p.onToggleShowAll} />
      </div>
      <div className="kc-toolbar-row">
        <button className="kc-btn" data-tip="Undo the last value change (Ctrl+Z)" onClick={p.onUndo}><span className="codicon codicon-discard" /></button>
        <button className="kc-btn" data-tip="Redo the last undone change (Ctrl+Y)" onClick={p.onRedo}><span className="codicon codicon-redo" /></button>
        {p.changeCount > 0 && (
          <button className={`kc-btn kc-changes-pill ${p.changesOpen ? 'on' : ''}`}
            data-tip={p.changesOpen ? 'Hide the list of pending changes' : 'Show what changed in this session'}
            onClick={p.onToggleChanges}>
            {p.changeCount} changed <span className={`codicon ${p.changesOpen ? 'codicon-chevron-up' : 'codicon-chevron-down'}`} />
          </button>
        )}
        <button className="kc-btn" data-tip="Save to the build's .config (shortcut: S). The next build applies it." onClick={p.onSave}>Save</button>
        <button className="kc-btn" data-tip="Save a copy of the full configuration to another file (shortcut: Shift+S)" onClick={p.onSaveAs}>Save As…</button>
        <button className="kc-btn" data-tip="Save a minimal defconfig: only options that differ from their defaults (shortcut: D)" onClick={p.onSaveMin}>Save minimal…</button>
        <button className="kc-btn" data-tip="Load a configuration file, replacing the current values (shortcut: O)" onClick={p.onOpen}>Open…</button>
        <button className="kc-btn" data-tip="Make the temporary .config values permanent in prj.conf" onClick={p.onPersistPrj}>To prj.conf</button>
        <button className="kc-btn" data-tip="Export the temporary .config values to an extra config fragment (EXTRA_CONF_FILE)" onClick={p.onPersistFragment}>To fragment…</button>
        {p.tempCount > 0 && (
          <button className="kc-btn kc-temp-pill" onClick={p.onPersistPrj}
            data-tip={`${p.tempCount} option(s) differ from the project's config files (temporary: a pristine build discards them)${p.tempStale ? '; note: the project config files changed since the last configure' : ''}. Click to make them permanent.`}>
            <span className="codicon codicon-history" /> {p.tempCount} temporary
          </button>
        )}
        {p.dirty && <span className="kc-dirty" data-tip="There are unsaved changes">● Modified</span>}
      </div>
    </div>
  );
}

function ChangesPanel({ changes, onJump, onRevert, onClose }: {
  changes: KcChange[];
  onJump: (id: NodeId) => void;
  onRevert: (name: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="kc-changes-panel">
      <div className="kc-changes-head">
        <span>{changes.length} pending change{changes.length === 1 ? '' : 's'} (not saved yet)</span>
        <button className="kc-btn" data-tip="Hide this list" onClick={onClose}>Show less</button>
      </div>
      {changes.length === 0 && <div className="kc-changes-empty">No changes in this session.</div>}
      {changes.map((c) => (
        <div key={c.name} className="kc-change-row">
          <button className="kc-link kc-change-name" data-tip="Go to this option in the tree"
            disabled={c.targetId === undefined}
            onClick={() => c.targetId !== undefined && onJump(c.targetId)}>{c.name}</button>
          <span className="kc-change-vals">
            <span className="kc-change-old">{c.baseline ?? '(unset)'}</span>
            <span className="codicon codicon-arrow-right" />
            <span className="kc-change-new">{c.current}</span>
          </span>
          <button className="kc-btn kc-change-revert" data-tip="Restore the value this option had when the panel opened"
            onClick={() => onRevert(c.name)}>Revert</button>
        </div>
      ))}
    </div>
  );
}

function Toggle({ on, label, title, onClick }: { on: boolean; label: string; title: string; onClick: () => void }) {
  return <button className={`kc-btn kc-toggle ${on ? 'on' : ''}`} data-tip={title} onClick={onClick}>{label}</button>;
}

/**
 * Confirmation overlay for the drift export: everything that differs between the current
 * configuration and the project's config fragments, with per-line checkboxes.
 */
function DriftOverlay({ state, dirty, onCancel, onJump, onWrite }: {
  state: DriftOverlayState;
  dirty: boolean;
  onCancel: () => void;
  onJump: (id: NodeId) => void;
  onWrite: (lines: string[]) => void;
}) {
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const toggle = (name: string) => {
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) { next.delete(name); } else { next.add(name); }
      return next;
    });
  };
  const selected = state.entries.filter((e) => !unchecked.has(e.name));
  const fileLabel = state.target === 'prj' ? 'prj.conf' : state.targetPath.split(/[\\/]/).pop();

  return (
    <div className="kc-jump-overlay" onClick={onCancel}>
      <div className="kc-jump kc-drift" onClick={(e) => e.stopPropagation()}>
        <div className="kc-drift-head">
          <span className="kc-drift-title">Make temporary values permanent</span>
          <span className="kc-drift-target" data-tip={state.targetPath}>target: {fileLabel}</span>
        </div>
        {state.stale && (
          <div className="kc-banner-warn">
            Project config files changed since the last configure{state.staleReason ? ` (${state.staleReason})` : ''}: some entries below may reflect those file edits rather than temporary values. Uncheck anything you do not want to persist.
          </div>
        )}
        {state.missingFragments.length > 0 && (
          <div className="kc-banner-warn">
            Ignored missing fragment file(s): {state.missingFragments.join(', ')}
          </div>
        )}
        {state.entries.length === 0 && (
          <div className="kc-drift-empty">No temporary changes: the configuration already matches the project's config files.</div>
        )}
        <div className="kc-drift-list">
          {state.entries.map((e) => (
            <div key={e.name} className="kc-change-row">
              <input type="checkbox" checked={!unchecked.has(e.name)} onChange={() => toggle(e.name)}
                data-tip="Include this option in the export" />
              <button className="kc-link kc-change-name" data-tip="Go to this option in the tree"
                disabled={e.targetId === undefined}
                onClick={() => e.targetId !== undefined && onJump(e.targetId)}>{e.name}</button>
              <span className="kc-change-vals">
                <span className="kc-change-old">{e.baseline ?? '(unset)'}</span>
                <span className="codicon codicon-arrow-right" />
                <span className="kc-change-new">{e.current}</span>
              </span>
              {e.overriddenBy && (
                <span className="kc-drift-override codicon codicon-warning"
                  data-tip={`Also set in ${e.overriddenBy}, which merges after ${fileLabel} and overrides this value`} />
              )}
            </div>
          ))}
        </div>
        <div className="kc-drift-foot">
          <span className="kc-drift-summary">
            {selected.length} of {state.entries.length} option(s) selected{dirty ? ' (includes unsaved edits)' : ''}
            {state.entries.length > 1 && (
              <>
                {' '}
                <button className="kc-link" data-tip="Select every option" onClick={() => setUnchecked(new Set())}>all</button>
                {' / '}
                <button className="kc-link" data-tip="Deselect every option"
                  onClick={() => setUnchecked(new Set(state.entries.map((e) => e.name)))}>none</button>
              </>
            )}
          </span>
          <span className="kc-drift-actions">
            <button className="kc-btn" onClick={onCancel}>Cancel</button>
            <button className="kc-btn kc-drift-write" disabled={selected.length === 0}
              onClick={() => onWrite(selected.map((e) => e.configString))}>
              Write to {fileLabel}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Always-visible location header: the Kconfig `mainmenu` prompt (menuconfig's screen
 * title) followed by the clickable menu path of the selected node, so any parent is one
 * click away.
 */
function PathBar({ store, selected, onSelectNode }: {
  store: KcStore; selected: NodeId | null;
  onSelectNode: (id: NodeId | null) => void;
}) {
  const label = (id: NodeId) => store.get(id)?.prompt ?? store.get(id)?.name ?? '…';
  const chain: { id: NodeId | null; label: string }[] = [{ id: null, label: store.mainmenu }];
  if (selected !== null) {
    for (const id of [...store.ancestors(selected)].reverse()) { chain.push({ id, label: label(id) }); }
    chain.push({ id: selected, label: label(selected) });
  }
  return (
    <div className="kc-breadcrumb">
      {chain.map((c, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="kc-crumb-sep codicon codicon-chevron-right" />}
          <button className={`kc-crumb ${i === 0 ? 'kc-crumb-root' : ''}`} onClick={() => onSelectNode(c.id)}
            data-tip={i === 0 ? 'Top level' : 'Go back to this parent'}>{c.label}</button>
        </React.Fragment>
      ))}
    </div>
  );
}

function StatusBar({ store, rows, dirty, warnings }: { store: KcStore; rows: FlatRow[]; dirty: boolean; warnings: string[] }) {
  const [showWarn, setShowWarn] = useState(false);
  return (
    <div className="kc-statusbar">
      {warnings.length > 0 && (
        <button className="kc-warn-toggle" onClick={() => setShowWarn((v) => !v)}>
          <span className="codicon codicon-warning" /> {warnings.length} warning{warnings.length > 1 ? 's' : ''}
        </button>
      )}
      <span className="kc-status-info">{store.nodes.size} nodes · showing {rows.length}{dirty ? ' · Modified' : ''}</span>
      <span className="kc-status-path" data-tip={store.configPath}>{store.configPath}</span>
      {showWarn && <pre className="kc-warn-list">{warnings.join('\n')}</pre>}
    </div>
  );
}

// --- Virtualized tree ------------------------------------------------------

export function VirtualTree(p: {
  store: KcStore; rows: FlatRow[]; selected: NodeId | null; showName: boolean;
  expanded: Set<string>;
  onSelect: (id: NodeId) => void;
  onToggleExpand: (n: KcNode) => void;
  onPrimary: (n: KcNode) => void;
  onEnter: (n: KcNode) => void;
  onSetValue: (id: NodeId, v: string) => void;
  onDirectSet: (n: KcNode, t: Tri) => void;
  onCycle: (n: KcNode) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  /** menuconfig's `---->` vs `----`: whether entering the node would show anything. */
  hasShownChildren: (id: NodeId) => boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) { return; }
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Keep the selected row in view.
  useEffect(() => {
    if (p.selected === null) { return; }
    const idx = p.rows.findIndex((r) => r.id === p.selected);
    if (idx < 0) { return; }
    const el = scrollRef.current;
    if (!el) { return; }
    const top = idx * ROW_H, bottom = top + ROW_H;
    if (top < el.scrollTop) { el.scrollTop = top; }
    else if (bottom > el.scrollTop + el.clientHeight) { el.scrollTop = bottom - el.clientHeight; }
  }, [p.selected, p.rows]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const count = Math.ceil(viewH / ROW_H) + OVERSCAN * 2;
  const slice = p.rows.slice(first, first + count);

  return (
    <div className="kc-tree" ref={scrollRef} tabIndex={0} role="tree"
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
      onKeyDown={p.onKeyDown}>
      <div className="kc-tree-spacer" style={{ height: p.rows.length * ROW_H }}>
        {slice.map((row, i) => {
          const node = p.store.get(row.id);
          if (!node) { return null; }
          return (
            <Row key={row.id} node={node} depth={row.depth} top={(first + i) * ROW_H}
              selected={row.id === p.selected} showName={p.showName}
              expanded={p.expanded.has(node.key)}
              emptyMenu={node.children.length > 0 && !p.hasShownChildren(node.id)}
              onSelect={() => p.onSelect(row.id)}
              onToggleExpand={() => p.onToggleExpand(node)}
              onPrimary={() => p.onPrimary(node)}
              onSetValue={(v) => p.onSetValue(node.id, v)}
              onDirectSet={(t) => p.onDirectSet(node, t)}
              onCycle={() => p.onCycle(node)}
            />
          );
        })}
      </div>
    </div>
  );
}

function Row(p: {
  node: KcNode; depth: number; top: number; selected: boolean; showName: boolean; expanded: boolean;
  emptyMenu: boolean;
  onSelect: () => void; onToggleExpand: () => void; onPrimary: () => void;
  onSetValue: (v: string) => void; onDirectSet: (t: Tri) => void; onCycle: () => void;
}) {
  const { node } = p;
  const cls = ['kc-row'];
  if (p.selected) { cls.push('sel'); }
  if (!node.visible) { cls.push('invisible'); }
  if (node.kind === 'comment') { cls.push('comment'); }

  return (
    <div className={cls.join(' ')} style={{ top: p.top, height: ROW_H }} onClick={p.onSelect} role="treeitem" aria-selected={p.selected}
      onDoubleClick={() => { if (node.isYModeChoiceSym) { p.onDirectSet(2); } }}>
      <span className="kc-indent" style={{ width: p.depth * 16 }} />
      {node.children.length > 0
        ? <span className={`kc-twistie codicon ${p.expanded ? 'codicon-chevron-down' : 'codicon-chevron-right'} ${p.emptyMenu ? 'empty' : ''}`}
            data-tip={p.emptyMenu ? 'Empty (nothing visible inside)' : undefined}
            onClick={() => p.onToggleExpand()} />
        : <span className="kc-twistie-spacer" />}
      <ValueControl node={node} onCycle={p.onCycle} onDirectSet={p.onDirectSet} onSetValue={p.onSetValue} />
      {p.showName && node.name && <span className="kc-symname">{node.name}</span>}
      <span className="kc-prompt" data-tip={node.name ? `CONFIG_${node.name}` : undefined}>{node.prompt ?? (node.name ?? '')}</span>
      {node.kind === 'choice' && node.selectionPrompt && <span className="kc-choice-sel">{node.selectionPrompt}</span>}
      {!node.userValueSet && node.kind === 'symbol' && <span className="kc-new">NEW</span>}
    </div>
  );
}

function ValueControl({ node, onCycle, onDirectSet, onSetValue }: {
  node: KcNode; onCycle: () => void; onDirectSet: (t: Tri) => void; onSetValue: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (node.kind === 'menu' || node.kind === 'comment') {
    return <span className="kc-ctrl kc-ctrl-none" />;
  }
  if (node.kind === 'choice') {
    return <span className="kc-ctrl codicon codicon-list-selection" />;
  }
  // Symbol. Value clicks intentionally bubble to the row so toggling an option also
  // selects it (updating the path bar and info pane).
  if (node.type === 'bool' || node.type === 'tristate') {
    if (node.isYModeChoiceSym) {
      // A real radio: an outlined ring, with an inner dot only when selected.
      return <span className={`kc-ctrl kc-radio ${node.choiceSelected ? 'on' : ''}`}
        role="radio" aria-checked={node.choiceSelected}
        data-tip={node.choiceSelected ? 'Currently selected' : 'Click to select this option (or double-click the row)'}
        onClick={() => onDirectSet(2)}><span className="kc-radio-ring" /></span>;
    }
    const locked = node.assignable.length <= 1;
    // menuconfig glyphs: [ ] empty when n, <M> for module, [*]/<*> checked when y.
    // An unset value is just an empty box (no X); locked symbols show a lock.
    const glyph = locked
      ? <span className="codicon codicon-lock" />
      : node.triValue === 2
        ? <span className="codicon codicon-check" />
        : node.triValue === 1
          ? <span className="kc-mglyph">M</span>
          : null;
    return <span className={`kc-ctrl kc-check tri${node.triValue} ${locked ? 'locked' : ''}`} data-tip={locked ? 'Locked by dependencies' : 'Toggle'}
      onClick={() => { if (!locked) { onCycle(); } }}>
      {glyph}
    </span>;
  }
  // string / int / hex
  if (editing) {
    return <InlineEditor node={node} onCommit={(v) => { setEditing(false); onSetValue(v); }} onCancel={() => setEditing(false)} />;
  }
  return <span className="kc-ctrl kc-value" onClick={() => setEditing(true)} data-tip="Click to edit">
    {node.strValue === '' ? '""' : node.strValue}
  </span>;
}

function InlineEditor({ node, onCommit, onCancel }: { node: KcNode; onCommit: (v: string) => void; onCancel: () => void }) {
  const [val, setVal] = useState(node.strValue);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const err = validate(node, val);
  return (
    <span className="kc-ctrl kc-editor" onClick={(e) => e.stopPropagation()}>
      <input ref={ref} className={err ? 'invalid' : ''} value={val} onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { if (!err) { onCommit(val); } e.stopPropagation(); }
          else if (e.key === 'Escape') { onCancel(); e.stopPropagation(); }
        }}
        onBlur={() => { if (!err) { onCommit(val); } else { onCancel(); } }} />
      {node.range && <span className="kc-hint">{node.type} (range: {node.range.low} to {node.range.high})</span>}
      {err && <span className="kc-err">{err}</span>}
    </span>
  );
}

export function InfoPane({ info, width, onNavigate, onOpenLocation }: {
  info?: KcNodeInfo; width: number;
  onNavigate: (id: NodeId) => void;
  onOpenLocation: (file: string, line: number) => void;
}) {
  if (!info) { return <div className="kc-info" style={{ width }}><div className="kc-info-empty">Select a symbol</div></div>; }
  return (
    <div className="kc-info" style={{ width }}>
      <div className="kc-info-head">
        {info.name && <span className="kc-info-name">{info.name}</span>}
        <span className="kc-info-type">{info.typeStr}</span>
        {info.valueStr !== undefined && <span className="kc-info-val">= {info.valueStr}</span>}
        {info.choiceMode && <span className="kc-info-val">mode {info.choiceMode}</span>}
      </div>
      {info.prompts.length > 0 && <Section title="Prompt">{info.prompts.map((s, i) => <div key={i}>{s}</div>)}</Section>}
      {info.blockers && info.blockers.length > 0 && (
        <Section title="Blocked by (unmet dependencies)" cls="kc-blockers">
          {info.blockers.map((l, i) => <ExprLine key={i} line={l} onNavigate={onNavigate} />)}
        </Section>
      )}
      {info.helps.length > 0 && <Section title="Help">{info.helps.map((h, i) => <pre key={i} className="kc-help">{h}</pre>)}</Section>}
      {info.directDep && (
        <Section title={`Direct dependencies (=${info.directDep.value})`}>
          {info.directDep.lines.map((l, i) => <ExprLine key={i} line={l} onNavigate={onNavigate} />)}
        </Section>
      )}
      {info.defaults.length > 0 && (
        <Section title="Defaults">
          {info.defaults.map((d, i) => (
            <div key={i} className="kc-default">
              <ExprLine line={d.value} onNavigate={onNavigate} />
              {d.condition && (
                <div className="kc-cond">
                  <span className="kc-op">if (={d.condition.value}) </span>
                  {d.condition.lines.map((l, li) => <ExprLine key={li} line={l} onNavigate={onNavigate} />)}
                </div>
              )}
            </div>
          ))}
        </Section>
      )}
      {info.choiceSyms && info.choiceSyms.length > 0 && (
        <Section title="Choice symbols">
          {info.choiceSyms.map((c, i) => (
            <div key={i} className="kc-choicesym">
              <button className="kc-link" disabled={c.targetId === undefined} onClick={() => c.targetId !== undefined && onNavigate(c.targetId)}>{c.name}</button>
              {c.selected && <span className="kc-sel-mark"> (selected)</span>}
            </div>
          ))}
        </Section>
      )}
      {info.selectImply.map((g, gi) => (
        <Section key={gi} title={g.title}>
          {g.syms.map((s, i) => (
            <button key={i} className="kc-link" disabled={s.targetId === undefined} onClick={() => s.targetId !== undefined && onNavigate(s.targetId)}>{s.name}</button>
          ))}
        </Section>
      ))}
      {info.definitions.map((d, i) => (
        <Section key={`def${i}`} title="Definition">
          <button className="kc-link" onClick={() => onOpenLocation(d.file, d.line)}>{d.file}:{d.line}</button>
          {d.includePath.length > 0 && (
            <div className="kc-includepath">
              Included via {d.includePath.map((h, hi) => (
                <React.Fragment key={hi}>
                  {hi > 0 && <span className="kc-op"> {'->'} </span>}
                  <button className="kc-link" onClick={() => onOpenLocation(h.file, h.line)}>{h.file}:{h.line}</button>
                </React.Fragment>
              ))}
            </div>
          )}
          {d.menuPath.length > 0 && (
            <div className="kc-menupath">
              {d.menuPath.map((m, mi) => (
                <React.Fragment key={mi}>
                  {mi > 0 && ' → '}
                  {m.targetId !== undefined
                    ? <button className="kc-link" onClick={() => onNavigate(m.targetId!)}>{m.label}</button>
                    : <span>{m.label}</span>}
                </React.Fragment>
              ))}
            </div>
          )}
          <pre className="kc-src">{d.kconfigSrc}</pre>
        </Section>
      ))}
    </div>
  );
}

function Section({ title, children, cls }: { title: string; children: React.ReactNode; cls?: string }) {
  return <div className={`kc-section ${cls ?? ''}`}><div className="kc-section-title">{title}</div><div className="kc-section-body">{children}</div></div>;
}

function ExprLine({ line, onNavigate }: { line: KcExprLine; onNavigate: (id: NodeId) => void }) {
  return <div className="kc-expr">{line.prefix && <span className="kc-op">{line.prefix} </span>}<ExprTokens line={line} onNavigate={onNavigate} />{line.valueHint && <span className="kc-vhint"> (={line.valueHint})</span>}</div>;
}
function ExprTokens({ line, onNavigate }: { line: KcExprLine; onNavigate: (id: NodeId) => void }) {
  return <>{line.tokens.map((t, i) => {
    if (t.t === 'sym') {
      return t.targetId !== undefined
        ? <button key={i} className="kc-link" onClick={() => onNavigate(t.targetId!)}>{t.name}<span className="kc-tokval">(={t.value})</span></button>
        : <span key={i} className="kc-sym-plain">{t.name}(={t.value})</span>;
    }
    return <span key={i} className={t.t === 'op' ? 'kc-op' : 'kc-text'}>{t.text}</span>;
  })}</>;
}

function JumpTo(p: {
  store: KcStore; showName: boolean;
  onClose: () => void; onJump: (id: NodeId) => void;
  onSetValue: (id: NodeId, v: string) => void; onDirectSet: (n: KcNode, t: Tri) => void; onCycle: (n: KcNode) => void;
}) {
  const [q, setQ] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const query = useMemo(() => compileQuery(q), [q]);
  const results = useMemo(() => (query.error ? [] : p.store.search(query)).slice(0, 500), [query, p.store]);

  return (
    <div className="kc-jump-overlay" onClick={p.onClose}>
      <div className="kc-jump" onClick={(e) => e.stopPropagation()}>
        <div className="kc-jump-input">
          <span className="codicon codicon-search" />
          <input ref={inputRef} placeholder="Jump to symbol (regex; space = AND)…" value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { p.onClose(); } if (e.key === 'Enter' && results[0] !== undefined) { p.onJump(results[0]); } }} />
        </div>
        {query.error && <div className="kc-jump-err">{query.error}</div>}
        {!query.error && q && <div className="kc-jump-count">{results.length} match{results.length === 1 ? '' : 'es'}</div>}
        <div className="kc-jump-results">
          {results.map((id) => {
            const node = p.store.get(id);
            if (!node) { return null; }
            return (
              <div key={id} className={`kc-jump-row ${node.visible ? '' : 'invisible'}`} onDoubleClick={() => p.onJump(id)}>
                <ValueControl node={node} onCycle={() => p.onCycle(node)} onDirectSet={(t) => p.onDirectSet(node, t)} onSetValue={(v) => p.onSetValue(node.id, v)} />
                {node.name && <span className="kc-symname">{node.name}</span>}
                <span className="kc-prompt" onClick={() => p.onJump(id)}>{node.prompt ?? ''}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// helpers
// ===========================================================================

function triStr(t: Tri): string { return t === 0 ? 'n' : t === 1 ? 'm' : 'y'; }

function isToggleable(node: KcNode): boolean {
  if (node.kind !== 'symbol') { return false; }
  if (node.type === 'bool' || node.type === 'tristate') { return node.assignable.length > 0; }
  return false;
}

function validate(node: KcNode, raw: string): string | undefined {
  if (node.type !== 'int' && node.type !== 'hex') { return undefined; }
  let s = raw.trim();
  if (node.type === 'hex' && !s.toLowerCase().startsWith('0x')) { s = '0x' + s; }
  let num: bigint;
  try { num = BigInt(s); } catch { return `'${raw}' is a malformed ${node.type} value`; }
  if (node.range) {
    const lo = BigInt(node.range.low);
    const hi = BigInt(node.range.high);
    if (num < lo || num > hi) { return `${raw} is outside the range ${node.range.low}-${node.range.high}`; }
  }
  return undefined;
}

function startResize(setWidth: (w: number) => void) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = (e.currentTarget.nextElementSibling as HTMLElement)?.clientWidth ?? 360;
    const onMove = (ev: MouseEvent) => setWidth(Math.max(220, Math.min(720, startW - (ev.clientX - startX))));
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
}
