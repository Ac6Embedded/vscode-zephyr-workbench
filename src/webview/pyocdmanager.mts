import { allComponents, provideVSCodeDesignSystem } from "@vscode/webview-ui-toolkit/";

provideVSCodeDesignSystem().register(
  allComponents
);

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

const webviewApi = acquireVsCodeApi();

const ACTION_BUTTON_IDS = [
  'update-index-btn', 'clean-packs-btn', 'find-btn', 'install-board-target-btn',
];

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setHidden(id: string, hidden: boolean) {
  el(id)?.classList.toggle('hidden', hidden);
}

function setActionsEnabled(enabled: boolean) {
  for (const id of ACTION_BUTTON_IDS) {
    const btn = el(id) as any;
    if (btn) {
      btn.disabled = !enabled;
    }
  }
  document.querySelectorAll('.pack-install-btn').forEach(btn => {
    (btn as any).disabled = !enabled;
  });
}

// Build cells via DOM APIs — pack/target names come from parsed CLI output and
// must not be interpolated into HTML.
function addRow(table: HTMLTableElement, cells: (string | Node)[]): HTMLTableRowElement {
  const row = table.insertRow();
  for (const cell of cells) {
    const td = row.insertCell();
    if (typeof cell === 'string') {
      td.textContent = cell;
    } else {
      td.appendChild(cell);
    }
  }
  return row;
}

function clearRows(table: HTMLTableElement) {
  while (table.rows.length > 1) {
    table.deleteRow(1);
  }
}

// Same look as the install buttons in the Install Runners panel: an icon
// button with the desktop-download codicon.
function makeInstallButton(pattern: string, installed: boolean | undefined): Node {
  if (installed) {
    const span = document.createElement('span');
    span.textContent = '● Installed';
    span.classList.add('pyocd-installed-mark');
    return span;
  }
  const btn = document.createElement('vscode-button');
  btn.classList.add('pack-install-btn');
  btn.setAttribute('appearance', 'icon');
  btn.setAttribute('title', 'Download and install this pack');
  const icon = document.createElement('span');
  icon.classList.add('codicon', 'codicon-desktop-download');
  btn.appendChild(icon);
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    webviewApi.postMessage({ command: 'install-pack', pattern });
  });
  return btn;
}

/* --- message handlers ----------------------------------------------------- */

function onVersionInfo(msg: any) {
  const text = el('pyocd-version-text');
  if (text) {
    text.textContent = msg.version ? `pyOCD v${msg.version} (installed in the Workbench environment)` : 'pyOCD: not found';
  }
  setHidden('pyocd-missing', !!msg.version);
  const warning = el('pyocd-version-warning');
  if (warning) {
    warning.textContent = msg.knownIssue ?? '';
  }
  setHidden('pyocd-version-warning', !msg.knownIssue);
}

function onBoardTargetInfo(msg: any) {
  setHidden('board-section', !msg.hasContext);
  if (!msg.hasContext) {
    return;
  }
  const project = el('board-project');
  if (project) { project.textContent = msg.projectName ?? ''; }
  const config = el('board-config');
  if (config) { config.textContent = msg.configName ?? ''; }

  setHidden('board-target-unknown', !!msg.target);
  setHidden('board-target-known', !msg.target);
  if (!msg.target) {
    return;
  }
  const target = el('board-target');
  if (target) { target.textContent = msg.target; }
  const status = el('board-target-status');
  if (status) {
    status.textContent = msg.installed ? '● Installed' : '✗ Not installed';
    status.classList.toggle('pyocd-installed-mark', !!msg.installed);
  }
  setHidden('install-board-target-btn', !!msg.installed);

  const packsNote = el('board-packs');
  if (packsNote) {
    if (msg.installed) {
      packsNote.textContent = '';
      setHidden('board-packs', true);
    } else if (msg.resolveFailed) {
      packsNote.textContent = 'Could not determine the CMSIS-Pack right now (pyOCD busy or unavailable). Installing will still resolve it automatically.';
      setHidden('board-packs', false);
    } else if (msg.resolving) {
      packsNote.textContent = 'Resolving which CMSIS-Pack provides this target...';
      setHidden('board-packs', false);
    } else if (Array.isArray(msg.packs)) {
      packsNote.textContent = msg.packs.length > 0
        ? `Resolves to: ${msg.packs.join(', ')}`
        : 'No CMSIS-Pack in the index provides this target. Try updating the index.';
      setHidden('board-packs', false);
    }
  }
}

function onInstalledPacks(msg: any) {
  const table = el<HTMLTableElement>('installed-packs-table');
  if (!table) {
    return;
  }
  clearRows(table);
  if (msg.error) {
    addRow(table, [`Could not list packs: ${msg.error}`, '']);
    return;
  }
  if (!msg.packs || msg.packs.length === 0) {
    addRow(table, ['No CMSIS-Pack installed (builtin targets remain available)', '']);
    return;
  }
  for (const pack of msg.packs) {
    addRow(table, [pack.pack ?? '', pack.version ?? '']);
  }
}

function onFindPacksResult(msg: any) {
  const table = el<HTMLTableElement>('find-results-table');
  if (!table) {
    return;
  }
  clearRows(table);
  const empty = !msg.packs || msg.packs.length === 0;
  setHidden('find-results-table', empty);
  setHidden('find-results-empty', !empty);
  if (empty) {
    return;
  }
  for (const pack of msg.packs) {
    addRow(table, [
      pack.part ?? '',
      pack.vendor ?? '',
      pack.pack ?? '',
      pack.version ?? '',
      makeInstallButton(pack.part ?? '', pack.installed),
    ]);
  }
}

const TARGETS_PAGE_SIZE = 30;
let targetRows: any[] = [];
let targetPage = 0;

function renderTargetsPage() {
  const table = el<HTMLTableElement>('targets-table');
  if (!table) {
    return;
  }
  clearRows(table);
  const pageCount = Math.max(1, Math.ceil(targetRows.length / TARGETS_PAGE_SIZE));
  targetPage = Math.min(Math.max(0, targetPage), pageCount - 1);
  const start = targetPage * TARGETS_PAGE_SIZE;
  for (const target of targetRows.slice(start, start + TARGETS_PAGE_SIZE)) {
    addRow(table, [target.name ?? '', target.vendor ?? '', target.partNumber ?? '', target.source ?? '']);
  }
  setHidden('targets-pagination', targetRows.length === 0);
  const info = el('targets-page-info');
  if (info) {
    const end = Math.min(targetRows.length, start + TARGETS_PAGE_SIZE);
    info.textContent = targetRows.length === 0
      ? ''
      : `${start + 1}-${end} of ${targetRows.length} targets (page ${targetPage + 1}/${pageCount})`;
  }
  const prev = el('targets-prev-btn') as any;
  if (prev) { prev.disabled = targetPage === 0; }
  const next = el('targets-next-btn') as any;
  if (next) { next.disabled = targetPage >= pageCount - 1; }
}

function onTargetsResult(msg: any) {
  const count = el('targets-count');
  if (msg.error) {
    targetRows = [];
    renderTargetsPage();
    if (count) { count.textContent = `Could not list targets: ${msg.error}`; }
    return;
  }
  if (count) {
    count.textContent = msg.total === 0 ? 'No target matches the filter.' : '';
  }
  targetRows = msg.targets ?? [];
  targetPage = 0;
  renderTargetsPage();
}

function onOpStarted(msg: any) {
  setActionsEnabled(false);
  setHidden('activity-idle', true);
  setHidden('activity-run', false);
  setHidden('activity-last', true);
  // Ops that run outside the panel's cancellation source (board-target
  // install) hide the in-panel Cancel: it could not stop them.
  setHidden('cancel-btn', msg.cancellable === false);
  const label = el('activity-label');
  if (label) { label.textContent = msg.label ?? msg.op; }
  const fill = el('activity-fill');
  if (fill) { fill.style.width = '0%'; }
  const detail = el('activity-detail');
  if (detail) { detail.textContent = ''; }
}

function onOpProgress(msg: any) {
  const fill = el('activity-fill');
  const detail = el('activity-detail');
  if (msg.total && fill) {
    fill.style.width = `${Math.min(100, (msg.current / msg.total) * 100)}%`;
  }
  if (detail) {
    detail.textContent = `Downloading (${msg.current}/${msg.total ?? '?'})`;
  }
}

function onOpFinished(msg: any) {
  setActionsEnabled(true);
  setHidden('activity-run', true);
  setHidden('activity-idle', false);
  const last = el('activity-last');
  if (last) {
    last.textContent = msg.success
      ? `Last operation finished: ${msg.op}`
      : `Last operation ${msg.message === 'Cancelled' ? 'cancelled' : 'failed'}: ${msg.op}${msg.message && msg.message !== 'Cancelled' ? ` (${msg.message})` : ''}`;
    setHidden('activity-last', false);
  }
}

/* --- wiring ---------------------------------------------------------------- */

function postTargetFilter() {
  webviewApi.postMessage({
    command: 'load-targets',
    name: (el('target-filter-name') as any)?.value ?? '',
    vendor: (el('target-filter-vendor') as any)?.value ?? '',
    source: (el('target-filter-source') as any)?.value ?? 'all',
  });
}

let filterDebounce: ReturnType<typeof setTimeout> | undefined;
function debouncedTargetFilter() {
  if (filterDebounce) {
    clearTimeout(filterDebounce);
  }
  filterDebounce = setTimeout(postTargetFilter, 300);
}

function main() {
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.command) {
      case 'version-info': onVersionInfo(msg); break;
      case 'index-status': setHidden('index-warning', msg.present !== false); break;
      case 'board-target-info': onBoardTargetInfo(msg); break;
      case 'installed-packs': onInstalledPacks(msg); break;
      case 'find-packs-result': onFindPacksResult(msg); break;
      case 'targets-result': onTargetsResult(msg); break;
      case 'op-started': onOpStarted(msg); break;
      case 'op-progress': onOpProgress(msg); break;
      case 'op-finished': onOpFinished(msg); break;
    }
  });

  el('refresh-version-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    webviewApi.postMessage({ command: 'refresh-version' });
  });
  el('open-output-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    webviewApi.postMessage({ command: 'open-output' });
  });
  el('open-install-runners-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    webviewApi.postMessage({ command: 'install-runners' });
  });
  el('refresh-packs-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    webviewApi.postMessage({ command: 'refresh-packs' });
  });
  el('update-index-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    webviewApi.postMessage({ command: 'update-pack-index' });
  });
  el('clean-packs-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    webviewApi.postMessage({ command: 'clean-packs' });
  });
  el('install-board-target-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    webviewApi.postMessage({ command: 'install-board-target' });
  });
  el('cancel-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    webviewApi.postMessage({ command: 'cancel' });
  });

  const postFind = () => {
    // Enter in the text field must respect the same lock as the (disabled)
    // Search button while an operation runs.
    if ((el('find-btn') as any)?.disabled) {
      return;
    }
    const pattern = `${(el('find-input') as any)?.value ?? ''}`.trim();
    if (pattern) {
      webviewApi.postMessage({ command: 'find-packs', pattern });
    }
  };
  el('find-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    postFind();
  });
  el('find-input')?.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      postFind();
    }
  });

  el('targets-header')?.addEventListener('click', () => {
    const body = el('targets-body');
    const collapsed = body?.classList.toggle('hidden') ?? true;
    const chevron = el('targets-chevron');
    chevron?.classList.toggle('codicon-chevron-right', collapsed);
    chevron?.classList.toggle('codicon-chevron-down', !collapsed);
  });
  el('target-filter-name')?.addEventListener('input', debouncedTargetFilter);
  el('target-filter-vendor')?.addEventListener('input', debouncedTargetFilter);
  el('target-filter-source')?.addEventListener('change', postTargetFilter);
  el('targets-prev-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    targetPage--;
    renderTargetsPage();
  });
  el('targets-next-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    targetPage++;
    renderTargetsPage();
  });

  webviewApi.postMessage({ command: 'webview-ready' });
}

window.addEventListener('load', main);
