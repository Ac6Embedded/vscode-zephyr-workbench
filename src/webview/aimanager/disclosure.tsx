// A row that shows its essentials and expands to show its details.
//
// Which rows are open is kept at the top of the app, not in each row, so a row
// stays open when the panel posts a new state or the user switches tabs and
// back.

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

/** Rows the user opened or closed, by id. A row not in it shows its default. */
export type OpenState = ReadonlyMap<string, boolean>;

export function isOpenIn(state: OpenState, id: string, defaultOpen: boolean): boolean {
  return state.get(id) ?? defaultOpen;
}

/** The state after the user clicks the row: open if it was closed, closed if it was open. */
export function toggledIn(state: OpenState, id: string, defaultOpen: boolean): OpenState {
  const next = new Map(state);
  next.set(id, !isOpenIn(state, id, defaultOpen));
  return next;
}

interface OpenRows {
  isOpen(id: string, defaultOpen: boolean): boolean;
  toggle(id: string, defaultOpen: boolean): void;
}

// Without a provider, as in the render tests, every row shows its default.
const OpenRowsContext = createContext<OpenRows>({
  isOpen: (_id, defaultOpen) => defaultOpen,
  toggle: () => undefined,
});

export function DisclosureProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState<OpenState>(() => new Map());
  const toggle = useCallback(
    (id: string, defaultOpen: boolean) => setOpen(current => toggledIn(current, id, defaultOpen)), []);
  const value = useMemo(() => ({
    isOpen: (id: string, defaultOpen: boolean) => isOpenIn(open, id, defaultOpen),
    toggle,
  }), [open, toggle]);
  return <OpenRowsContext.Provider value={value}>{children}</OpenRowsContext.Provider>;
}

export function Disclosure({ id, summary, actions, actionsWhenClosed, defaultOpen = false, className, children }: {
  /** Unique in the panel. */
  id: string;
  /** What shows while closed, next to the chevron. */
  summary: React.ReactNode;
  /** Buttons that stay visible beside the summary, outside the toggle. */
  actions?: React.ReactNode;
  /** Show `actions` only while closed, because the details repeat them. */
  actionsWhenClosed?: boolean;
  /** Open until the user closes it. */
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const { isOpen, toggle } = useContext(OpenRowsContext);
  const open = isOpen(id, defaultOpen);
  const bodyId = `zw-details-${id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const showActions = !!actions && !(open && actionsWhenClosed);
  return (
    <div className={['zw-disclosure', open ? 'open' : '', className ?? ''].filter(Boolean).join(' ')}>
      <div className="zw-disclosure-head">
        <button
          type="button"
          className="zw-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => toggle(id, defaultOpen)}
        >
          <span className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} aria-hidden="true" />
          {summary}
        </button>
        {showActions ? <div className="zw-actions">{actions}</div> : null}
      </div>
      <div id={bodyId} className="zw-disclosure-body" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
