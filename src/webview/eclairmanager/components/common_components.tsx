import React, { useEffect, useState } from "react";

// Web component wrappers for VSCode UI Toolkit
export function VscodeButton(
  props: React.ButtonHTMLAttributes<HTMLButtonElement> & { appearance: "primary" | "secondary" | "icon" }
) {
  return React.createElement("vscode-button", props, props.children);
}

export function VscodeTextField(props: any) {
  return React.createElement("vscode-text-field", props, props.children);
}

export function VscodeRadioGroup(props: any) {
  return React.createElement("vscode-radio-group", props, props.children);
}

export function VscodeRadio(props: any) {
  return React.createElement("vscode-radio", props, props.children);
}

export function VscodeCheckbox(props: any) {
  return React.createElement("vscode-checkbox", props, props.children);
}

export function VscodeDropdown(props: any) {
  return React.createElement("vscode-dropdown", props, props.children);
}

export function VscodeOption(props: any) {
  return React.createElement("vscode-option", props, props.children);
}

export function VscodeBadge(props: any) {
  return React.createElement("vscode-badge", props, props.children);
}

export function VscodePanel(props: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{
      marginBottom: "16px",
      padding: "12px",
      border: "1px solid var(--vscode-panel-border)",
      borderRadius: "4px",
      backgroundColor: "var(--vscode-editor-background)",
      ...props.style
    }}>
      {props.children}
    </div>
  );
}

export function VscodeAlert(props: {
  type?: "info" | "warning" | "error" | "success";
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  const type = props.type ?? "info";
  
  const iconMap = {
    info: "codicon-info",
    warning: "codicon-warning",
    error: "codicon-error",
    success: "codicon-check"
  };

  const colorMap = {
    info: "var(--vscode-notificationsInfoIcon-foreground, #3794ff)",
    warning: "var(--vscode-notificationsWarningIcon-foreground, #cca700)",
    error: "var(--vscode-notificationsErrorIcon-foreground, #f48771)",
    success: "var(--vscode-debugIcon-startForeground, #89d185)"
  };

  const bgMap = {
    info: "var(--vscode-inputValidation-infoBackground, rgba(55, 148, 255, 0.15))",
    warning: "var(--vscode-inputValidation-warningBackground, rgba(204, 167, 0, 0.15))",
    error: "var(--vscode-inputValidation-errorBackground, rgba(244, 135, 113, 0.15))",
    success: "rgba(137, 209, 133, 0.15)"
  };

  const borderMap = {
    info: "var(--vscode-inputValidation-infoBorder, rgba(55, 148, 255, 0.62))",
    warning: "var(--vscode-inputValidation-warningBorder, rgba(204, 167, 0, 0.62))",
    error: "var(--vscode-inputValidation-errorBorder, rgba(244, 135, 113, 0.62))",
    success: "rgba(137, 209, 133, 0.62)"
  };

  return (
    <div style={{
      display: "flex",
      alignItems: "flex-start",
      gap: "10px",
      //marginBottom: "12px",
      margin: "12px",
      padding: "10px 12px",
      border: `1px solid ${borderMap[type]}`,
      borderRadius: "4px",
      backgroundColor: bgMap[type],
      ...props.style
    }}>
      <span 
        className={`codicon ${iconMap[type]}`} 
        style={{ 
          color: colorMap[type],
          fontSize: "16px",
          marginTop: "2px",
          flexShrink: 0
        }}
      />
      <div style={{ flex: 1 }}>
        {props.children}
      </div>
    </div>
  );
}

export type StatusBadgeState =
  | { kind: "idle"; label?: string | React.ReactNode }
  | { kind: "loading"; label?: string | React.ReactNode }
  | { kind: "success"; label: string | React.ReactNode; detail?: string | React.ReactNode }
  | { kind: "error"; label?: string | React.ReactNode; message: string | React.ReactNode };

export function StatusBadge({ status }: { status: StatusBadgeState }) {
  switch (status.kind) {
    case "idle":
      return (
        <span style={{ color: "var(--vscode-descriptionForeground)", fontSize: "0.85em" }}>
          {status.label ?? "Not scanned"}
        </span>
      );
    case "loading":
      return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "0.85em", color: "var(--vscode-descriptionForeground)" }}>
          <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" style={{ fontSize: "0.95em" }} />
          {status.label ?? "Loading\u2026"}
        </span>
      );
    case "success":
      return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "0.85em", color: "var(--vscode-testing-iconPassed)" }}>
          <span className="codicon codicon-check" aria-hidden="true" />
          {status.label}
          {status.detail && (
            <span style={{ color: "var(--vscode-descriptionForeground)" }}>{status.detail}</span>
          )}
        </span>
      );
    case "error": {
      const label = status.label ?? "Error";
      return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "0.85em", color: "var(--vscode-errorForeground)" }}>
          <span className="codicon codicon-error" aria-hidden="true" />
          {label}
          <RichHelpTooltip
            style={{ marginLeft: "2px", color: "var(--vscode-errorForeground)", fontSize: "0.9em" }}
          >{status.message}</RichHelpTooltip>
        </span>
      );
    }
  }
}

export function SimpleHelpTooltip(props: {
  text: string;
  label?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className="tooltip"
      data-tooltip={props.text}
      style={{ marginLeft: "8px", ...props.style }}
    >
      {props.label ?? "?"}
    </span>
  );
}

export function RichHelpTooltip(props: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  const [visible, setVisible] = useState(false);
  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const showTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (!visible) {
      showTimer.current = setTimeout(() => setVisible(true), 400);
    }
  };

  const hide = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), 200);
  };

  return (
    <span
      className="rich-tooltip"
      style={{ marginLeft: "8px", ...props.style }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <span
        className="codicon codicon-question"
        aria-hidden="true"
        style={{ fontSize: "20px", display: "inline-block", verticalAlign: "middle", lineHeight: 1 }}
      />
      <span
        className={"rich-tooltip-content" + (visible ? " rich-tooltip-content--visible" : "")}
        role="tooltip"
        onMouseEnter={show}
        onMouseLeave={hide}
        style={{
          fontWeight: "normal",
          textAlign: "left",
          textJustify: "inter-word",
        }}
      >
        {props.children}
      </span>
    </span>
  );
}

export interface SearchableItem { id: string | number; name: string; description: string | { content: React.ReactNode, searchable?: string } };

export function SearchableDropdown<Item extends SearchableItem>(props: {
  id: string;
  label: string;
  placeholder: string;
  items: Item[];
  selectedItem: Item | null;
  onSelectItem: (item: Item) => void;
  style?: React.CSSProperties;
}) {
  const [searchText, setSearchText] = React.useState<string>('');
  const dropdownRef = React.useRef<HTMLDivElement>(null);
  const [showDropdown, setShowDropdown] = React.useState<boolean>(false);

  const selectedName = props.selectedItem?.name ?? '';

  useEffect(() => {
    if (!showDropdown) {
      setSearchText(selectedName);
    }
  }, [selectedName, showDropdown]);

  const filteredItems = props.items.filter((item) => {
    const description = typeof item.description === "string" ? item.description : item.description.searchable ?? "";
    return (
      item.name.toLowerCase().includes(searchText.toLowerCase()) ||
      description.toLowerCase().includes(searchText.toLowerCase())
    );
  });

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div style={{ ...props.style }}>
      {props.label && <label style={{ marginBottom: "5px", display: "block" }} htmlFor={props.id}>{props.label}</label>}
      <div ref={dropdownRef} style={{ position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', position: 'relative' }}>
          <input
            id={props.id}
            type="text"
            placeholder={props.placeholder}
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value);
              setShowDropdown(true);
            }}
            onFocus={() => {
              setSearchText('');
              setShowDropdown(true);
            }}
            style={{
              width: '100%',
              padding: '4px 24px 4px 8px',
              backgroundColor: 'var(--vscode-input-background)',
              color: 'var(--vscode-input-foreground)',
              border: '1px solid var(--vscode-input-border)',
              outline: 'none',
              fontFamily: 'var(--vscode-font-family)',
              fontSize: 'var(--vscode-font-size)',
            }}
          />
          <div style={{
            position: 'absolute',
            right: '8px',
            pointerEvents: 'none',
          }}>
            <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
              <path fillRule="evenodd" clipRule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" />
            </svg>
          </div>
        </div>
        {showDropdown && (
          <div style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            maxHeight: '200px',
            overflowY: 'auto',
            backgroundColor: 'var(--vscode-dropdown-background)',
            border: '1px solid var(--vscode-dropdown-border)',
            zIndex: 1000,
            marginTop: '2px',
          }}>
            {filteredItems.length > 0 ? (
              filteredItems.map((item) => (
                <div
                  key={item.id}
                  onClick={() => {
                    props.onSelectItem(item);
                    setSearchText(item.name);
                    setShowDropdown(false);
                  }}
                  style={{
                    padding: '6px 8px',
                    cursor: 'pointer',
                    borderBottom: '1px solid var(--vscode-dropdown-border)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--vscode-list-hoverBackground)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  <div style={{ fontWeight: 500 }}>{item.name}</div>
                  <div style={{ fontSize: '0.9em', color: 'var(--vscode-descriptionForeground)' }}>
                    {typeof item.description === "string" ? item.description : item.description.content}
                  </div>
                </div>
              ))
            ) : (
              <div style={{ padding: '6px 8px', color: 'var(--vscode-descriptionForeground)' }}>
                No presets found
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function PickPath({
  value,
  name,
  placeholder,
  on_selected,
  on_pick,
}: {
  value: string;
  name?: string;
  placeholder?: string;
  on_selected: (new_value: string) => void;
  on_pick: () => void;
}) {
  const [current_value, set_current_value] = useState<string>(value);
  const [editing, set_editing] = useState<boolean>(false);

  // When the value prop changes (e.g. due to external updates), update the
  // current_value state to reflect the new value.
  useEffect(() => {
    set_current_value(value);
    //set_editing(false);
  }, [value]);

  // Ensure that if the value changes externally while the user is not editing.
  if (!editing && value !== current_value) {
    set_current_value(value);
  }

  return (<div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "10px" }}>
    {name ? `${name}:` : "Path:"}
    <VscodeTextField
      className="details-path-field"
      placeholder={placeholder}
      size="38"
      style={{ flexGrow: 1 }}
      value={current_value}
      disabled={!editing}
      onInput={(e: any) => set_current_value(e.target.value)}
      onChange={(e: any) => set_current_value(e.target.value)}
      onKeyDown={(e: any) => {
        if (e.key === "Enter" && editing) {
          const submitted = (e.target as any)?.value ?? current_value;
          set_editing(false);
          on_selected(submitted);
        } else if (e.key === "Escape" && editing) {
          set_current_value(value);
          set_editing(false);
        }
      }}
    />

    {/* Pick button */}
    {editing && (
      <VscodeButton
        className="browse-extra-input-button"
        appearance="secondary"
        onClick={() => {
          on_pick();
        }}
      >
        <span className="codicon codicon-folder"></span>
      </VscodeButton>
    )}

    {/* Edit/Done button */}
    <VscodeButton appearance="primary" onClick={() => {
      if (editing) {
        on_selected(current_value);
        set_editing(false);
      } else {
        set_editing(true);
      }
    }}>
      {editing ? "Done" : "Edit"}
    </VscodeButton>

    {/* Cancel button */}
    {editing && (
      <VscodeButton appearance="secondary" onClick={() => {
        set_current_value(value);
        set_editing(false);
      }} style={{ marginLeft: '5px' }}>
        Cancel
      </VscodeButton>
    )}
  </div>);
}

export function EditableTextField({
  value,
  name,
  placeholder,
  style,
  on_selected,
}: {
  value: string;
  name?: string;
  placeholder?: string;
  style?: React.CSSProperties;
  on_selected: (new_value: string) => void;
}) {
  const [current_value, set_current_value] = useState<string>(value);
  const [editing, set_editing] = useState<boolean>(false);

  useEffect(() => {
    set_current_value(value);
  }, [value]);

  if (!editing && value !== current_value) {
    set_current_value(value);
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "10px", ...style }}>
      {name ? `${name}:` : "Value:"}
      <VscodeTextField
        placeholder={placeholder}
        size="38"
        style={{ flexGrow: 1 }}
        value={current_value}
        disabled={!editing}
        onInput={(e: any) => set_current_value(e.target.value)}
        onChange={(e: any) => set_current_value(e.target.value)}
        onKeyDown={(e: any) => {
          if (e.key === "Enter" && editing) {
            const submitted = (e.target as any)?.value ?? current_value;
            on_selected(submitted);
            set_editing(false);
          } else if (e.key === "Escape" && editing) {
            set_current_value(value);
            set_editing(false);
          }
        }}
      />

      <VscodeButton
        appearance="icon"
        onClick={() => {
          if (editing) {
            on_selected(current_value);
            set_editing(false);
          } else {
            set_editing(true);
          }
        }}
      >
        <span className={`codicon ${editing ? "codicon-check" : "codicon-edit"}`} aria-hidden="true" />
      </VscodeButton>

      {editing && (
        <VscodeButton
          appearance="icon"
          onClick={() => {
            set_current_value(value);
            set_editing(false);
          }}
          style={{ marginLeft: "5px" }}
        >
          <span className="codicon codicon-x" aria-hidden="true" />
        </VscodeButton>
      )}
    </div>
  );
}

export function Monospace(props: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <span style={{ fontFamily: "var(--vscode-editor-font-family)", ...props.style }}>
      {props.children}
    </span>
  );
}
