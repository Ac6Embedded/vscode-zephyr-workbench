import { Button, TextField, allComponents, provideVSCodeDesignSystem } from "@vscode/webview-ui-toolkit/";

provideVSCodeDesignSystem().register(allComponents);

const webviewApi = acquireVsCodeApi();

interface WestManagerWorkspaceSummary {
  name: string;
  rootPath: string;
  version: string;
}

interface WestManagerWorkspaceDetails extends WestManagerWorkspaceSummary {
  configPath: string;
  manifestPath: string;
  zephyrBase: string;
  zephyrWestPath: string;
  submanifestPaths: string[];
  zephyrRepoUrl: string;
  zephyrRevision: string;
  importAll: boolean;
  availableProjects: string[];
  selectedProjects: string[];
}

interface WestManagerState {
  workspaces: WestManagerWorkspaceSummary[];
  selectedRootPath: string;
  details?: WestManagerWorkspaceDetails;
  error?: string;
}

let currentState: WestManagerState = (window as any).zephyrWestManagerInitialState ?? {
  workspaces: [],
  selectedRootPath: '',
};
let currentDetails: WestManagerWorkspaceDetails | undefined = currentState.details;
let selectedProjects = new Set<string>();

window.addEventListener('load', main);

function main() {
  setVSCodeMessageListener();
  renderState(currentState);
  initRevisionDropdown();

  const workspaceSelect = document.getElementById('workspaceSelect') as HTMLSelectElement | null;
  workspaceSelect?.addEventListener('change', () => {
    const rootPath = workspaceSelect.value;
    setStatus('Loading workspace...');
    webviewApi.postMessage({ command: 'loadWorkspace', rootPath });
  });

  const projectFilter = document.getElementById('projectFilter') as TextField | null;
  projectFilter?.addEventListener('input', renderProjects);

  const selectAllButton = document.getElementById('selectAllProjectsButton') as HTMLButtonElement | null;
  selectAllButton?.addEventListener('click', () => {
    if (!currentDetails) { return; }
    selectedProjects = new Set(currentDetails.availableProjects);
    renderProjects();
  });

  const clearButton = document.getElementById('clearProjectsButton') as HTMLButtonElement | null;
  clearButton?.addEventListener('click', () => {
    selectedProjects.clear();
    renderProjects();
  });

  const applyButton = document.getElementById('applyButton') as Button | null;
  applyButton?.addEventListener('click', event => {
    event.preventDefault();
    postOperation('apply');
  });

  const updateButton = document.getElementById('updateButton') as Button | null;
  updateButton?.addEventListener('click', event => {
    event.preventDefault();
    if (!currentDetails) { return; }
    setOperationButtonsDisabled(true);
    setStatus('Updating workspace...');
    webviewApi.postMessage({ command: 'update', rootPath: currentDetails.rootPath });
  });

  const applyUpdateButton = document.getElementById('applyUpdateButton') as Button | null;
  applyUpdateButton?.addEventListener('click', event => {
    event.preventDefault();
    postOperation('applyAndUpdate');
  });

  const refreshButton = document.getElementById('refreshButton') as Button | null;
  refreshButton?.addEventListener('click', event => {
    event.preventDefault();
    setStatus('Refreshing...');
    webviewApi.postMessage({ command: 'refresh' });
  });

  webviewApi.postMessage({ command: 'webviewReady' });
}

function setVSCodeMessageListener() {
  window.addEventListener('message', event => {
    switch (event.data.command) {
      case 'managerState':
        currentState = event.data.state;
        renderState(currentState);
        break;
      case 'workspaceDetails':
        currentDetails = event.data.details;
        currentState.selectedRootPath = currentDetails?.rootPath ?? '';
        renderDetails(currentDetails);
        setOperationButtonsDisabled(false);
        setStatus(event.data.status ?? '');
        break;
      case 'revisionOptions':
        updateRevisionDropdown(event.data.revisionHTML, event.data.revision);
        break;
      case 'revisionOptionsError':
        updateRevisionDropdown(`<div class="dropdown-header error">Error: ${escapeHtml(event.data.message || 'Could not load revisions')}</div>`, undefined);
        break;
      case 'workspaceError':
      case 'operationError':
        setOperationButtonsDisabled(false);
        setError(event.data.message || 'West Manager operation failed.');
        break;
    }
  });
}

function renderState(state: WestManagerState) {
  renderWorkspaceSelect(state);

  if (state.details) {
    renderDetails(state.details);
    setStatus('');
    return;
  }

  currentDetails = undefined;
  setEmptyState(state.error || 'Select a west workspace.');
}

function renderWorkspaceSelect(state: WestManagerState) {
  const workspaceSelect = document.getElementById('workspaceSelect') as HTMLSelectElement | null;
  if (!workspaceSelect) {
    return;
  }

  workspaceSelect.innerHTML = '';
  for (const workspace of state.workspaces) {
    const option = document.createElement('option');
    option.value = workspace.rootPath;
    option.textContent = `${workspace.name} [${workspace.version}]`;
    option.selected = workspace.rootPath === state.selectedRootPath;
    workspaceSelect.appendChild(option);
  }

  workspaceSelect.disabled = state.workspaces.length === 0;
}

function renderDetails(details: WestManagerWorkspaceDetails | undefined) {
  if (!details) {
    setEmptyState('Select a west workspace.');
    return;
  }

  currentDetails = details;
  selectedProjects = new Set(details.selectedProjects);

  const detailsRoot = document.getElementById('workspaceDetails') as HTMLElement | null;
  const empty = document.getElementById('workspaceEmpty') as HTMLElement | null;
  if (detailsRoot) {
    detailsRoot.style.display = '';
  }
  if (empty) {
    empty.textContent = '';
  }

  const revisionInput = document.getElementById('revisionInput') as HTMLInputElement | null;
  if (revisionInput) {
    revisionInput.value = details.zephyrRevision;
    revisionInput.setAttribute('data-value', details.zephyrRevision);
  }
  setRevisionLoading(true);

  setText('versionText', details.version);
  setText('zephyrBaseText', details.zephyrBase);
  setText('zephyrRepoUrlText', details.zephyrRepoUrl);
  setText('manifestPathText', details.manifestPath);
  setText('zephyrWestPathText', details.zephyrWestPath);
  setText('submanifestsText', details.submanifestPaths.length > 0 ? details.submanifestPaths.join(', ') : 'None');

  renderProjects();
  setOperationButtonsDisabled(false);
}

function setEmptyState(message: string) {
  const detailsRoot = document.getElementById('workspaceDetails') as HTMLElement | null;
  const empty = document.getElementById('workspaceEmpty') as HTMLElement | null;
  if (detailsRoot) {
    detailsRoot.style.display = 'none';
  }
  if (empty) {
    empty.textContent = message;
  }
  setRevisionLoading(false);
  setOperationButtonsDisabled(true);
}

function renderProjects() {
  const list = document.getElementById('projectsList') as HTMLElement | null;
  if (!list || !currentDetails) {
    return;
  }

  const filterInput = document.getElementById('projectFilter') as TextField | null;
  const filter = (filterInput?.value ?? '').trim().toLowerCase();
  const projects = currentDetails.availableProjects.filter(projectName => projectName.toLowerCase().includes(filter));

  list.innerHTML = '';
  if (currentDetails.availableProjects.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'projects-empty';
    empty.textContent = 'No projects found in the local zephyr west.yml or submanifests.';
    list.appendChild(empty);
    return;
  }

  if (projects.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'projects-empty';
    empty.textContent = 'No projects match the filter.';
    list.appendChild(empty);
    return;
  }

  for (const projectName of projects) {
    const row = document.createElement('label');
    row.className = 'west-manager-project-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedProjects.has(projectName);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        selectedProjects.add(projectName);
      } else {
        selectedProjects.delete(projectName);
      }
    });

    const text = document.createElement('span');
    text.textContent = projectName;

    row.appendChild(checkbox);
    row.appendChild(text);
    list.appendChild(row);
  }
}

function initRevisionDropdown() {
  const revisionInput = document.getElementById('revisionInput') as HTMLInputElement | null;
  const revisionDropdown = document.getElementById('revisionDropdown') as HTMLElement | null;
  const refreshButton = document.getElementById('revisionRefreshButton') as HTMLButtonElement | null;
  if (!revisionInput || !revisionDropdown) {
    return;
  }

  revisionInput.addEventListener('focusin', () => {
    revisionDropdown.style.display = 'block';
  });
  revisionInput.addEventListener('focusout', () => {
    revisionDropdown.style.display = 'none';
  });
  revisionInput.addEventListener('click', () => {
    revisionDropdown.style.display = 'block';
  });
  revisionInput.addEventListener('keyup', () => filterDropdown(revisionInput, revisionDropdown));

  revisionDropdown.addEventListener('mousedown', event => event.preventDefault());
  revisionDropdown.addEventListener('mouseup', event => event.preventDefault());

  refreshButton?.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    refreshRevisionOptions();
  });
}

function refreshRevisionOptions() {
  if (!currentDetails) {
    return;
  }
  setRevisionLoading(true);
  webviewApi.postMessage({ command: 'refreshRevisions', rootPath: currentDetails.rootPath });
}

function updateRevisionDropdown(revisionHTML: string, revision: string | undefined) {
  const revisionInput = document.getElementById('revisionInput') as HTMLInputElement | null;
  const revisionDropdown = document.getElementById('revisionDropdown') as HTMLElement | null;
  if (!revisionInput || !revisionDropdown) {
    return;
  }

  if (typeof revision === 'string') {
    revisionInput.value = revision;
    revisionInput.setAttribute('data-value', revision);
  }
  revisionDropdown.innerHTML = revisionHTML;
  addDropdownItemEventListeners(revisionDropdown, revisionInput);
  setRevisionLoading(false);
}

function setRevisionLoading(isLoading: boolean) {
  const spinner = document.getElementById('revisionLoadingSpinner') as HTMLElement | null;
  if (spinner) {
    spinner.style.visibility = isLoading ? 'visible' : 'hidden';
  }
}

function addDropdownItemEventListeners(dropdown: HTMLElement, input: HTMLInputElement) {
  const items = dropdown.getElementsByClassName('dropdown-item');
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as HTMLElement;
    item.addEventListener('click', () => {
      input.value = item.getAttribute('data-label') || '';
      input.setAttribute('data-value', item.getAttribute('data-value') || '');
      input.dispatchEvent(new Event('input'));
      dropdown.style.display = 'none';
    });
  }
}

function filterDropdown(input: HTMLInputElement, dropdown: HTMLElement) {
  const filter = input.value.toUpperCase();
  const headers = dropdown.getElementsByClassName('dropdown-header');
  const items = dropdown.getElementsByClassName('dropdown-item');

  for (let i = 0; i < items.length; i++) {
    const item = items[i] as HTMLElement;
    const textValue = item.textContent || item.innerText;
    item.style.display = textValue.toUpperCase().indexOf(filter) > -1 ? '' : 'none';
  }

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i] as HTMLElement;
    let nextElement = header.nextElementSibling as HTMLElement | null;
    let hasVisibleItems = false;
    while (nextElement && !nextElement.classList.contains('dropdown-header')) {
      if (nextElement.classList.contains('dropdown-item') && nextElement.style.display !== 'none') {
        hasVisibleItems = true;
        break;
      }
      nextElement = nextElement.nextElementSibling as HTMLElement | null;
    }
    header.style.display = hasVisibleItems ? '' : 'none';
  }
}

function postOperation(command: 'apply' | 'applyAndUpdate') {
  if (!currentDetails) {
    return;
  }

  const revisionInput = document.getElementById('revisionInput') as HTMLInputElement | null;
  setOperationButtonsDisabled(true);
  setStatus(command === 'apply' ? 'Applying manifest changes...' : 'Applying manifest changes and updating workspace...');
  webviewApi.postMessage({
    command,
    state: {
      rootPath: currentDetails.rootPath,
      zephyrRevision: revisionInput?.value ?? '',
      selectedProjects: Array.from(selectedProjects),
    },
  });
}

function setText(id: string, value: string) {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = value;
    element.title = value;
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setStatus(message: string) {
  const status = document.getElementById('managerStatus') as HTMLElement | null;
  if (status) {
    status.classList.remove('error');
    status.textContent = message;
  }
}

function setError(message: string) {
  const status = document.getElementById('managerStatus') as HTMLElement | null;
  if (status) {
    status.classList.add('error');
    status.textContent = message;
  }
}

function setOperationButtonsDisabled(disabled: boolean) {
  for (const id of ['applyButton', 'updateButton', 'applyUpdateButton']) {
    const button = document.getElementById(id) as HTMLElement | null;
    if (!button) {
      continue;
    }
    if (disabled) {
      button.setAttribute('disabled', 'true');
    } else {
      button.removeAttribute('disabled');
    }
  }
}
