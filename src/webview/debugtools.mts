import { Button, Dropdown, DropdownOptions, TextField, allComponents,
    provideVSCodeDesignSystem } from "@vscode/webview-ui-toolkit/";
  
provideVSCodeDesignSystem().register(
allComponents
);

const webviewApi = acquireVsCodeApi();

window.addEventListener("load", main);

function main() {
  setVSCodeMessageListener();
  webviewApi.postMessage({ command: 'webview-ready' });

  const installButtons = document.querySelectorAll('.install-button');
  installButtons.forEach(button => {
    button.addEventListener('click', () => {
      const tool = button.getAttribute('data-tool');
      const progress = document.getElementById(`progress-${tool}`) as HTMLElement;
      progress.style.display = 'block';
      webviewApi.postMessage({
        command: 'install',
        tool: tool
      });
    });
  });

  const installPackButtons = document.querySelectorAll('.install-pack-button');
  installPackButtons.forEach(button => {
    button.addEventListener('click', () => {
      const pack = button.getAttribute('data-pack');
      const tools = button.getAttribute('data-tools');
      if(tools) {
        for(let tool of tools.split(';')) {
          const progress = document.getElementById(`progress-${tool}`) as HTMLElement;
          if(progress) {
            progress.style.display = 'block';
          }
        }
      }
      webviewApi.postMessage({
        command: 'install-pack',
        pack: pack
      });
    });
  });

  const removeButtons = document.querySelectorAll('.remove-button');
  removeButtons.forEach(button => {
    button.addEventListener('click', () => {
      const tool = button.getAttribute('data-tool');
      const progress = document.getElementById(`progress-${tool}`) as HTMLElement;
      //progress.style.display = 'block';
      webviewApi.postMessage({
        command: 'remove',
        tool: tool
      });
    });
  });

  const progressWheel = document.querySelectorAll('.progress-wheel') as NodeListOf<HTMLElement>;
  progressWheel.forEach(pw => {
    pw.style.display = 'none';
  });

  // Set default checkbox
  const setDefaultCheckboxes = document.querySelectorAll('.set-default-checkbox');
  setDefaultCheckboxes.forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const target = e.target as HTMLElement;
      const tool = target.getAttribute('data-tool');
      const alias = target.getAttribute('data-alias');
      if ((e.target as HTMLInputElement).checked) {
        webviewApi.postMessage({
          command: 'set-default',
          tool: tool,
          alias: alias
        });
      }
    });
  });

  // Refresh all runner statuses: clear cells and ask backend to re-detect
  const refreshBtn = document.getElementById('refresh-status-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      // Clear Version and Status columns
      document.querySelectorAll('[id^="version-"]')
        .forEach(el => { (el as HTMLElement).textContent = ''; });
      document.querySelectorAll('[id^="detect-"]')
        .forEach(el => { (el as HTMLElement).textContent = ''; });

      // Trigger backend to re-run detection for all tools
      webviewApi.postMessage({ command: 'refresh-all' });
    });
  }

  // Expand or collapse details row under the application name
  const expandButtons = document.querySelectorAll('.expand-button');
  expandButtons.forEach(button => {
    button.addEventListener('click', () => {
      const tool = button.getAttribute('data-tool');
      const extraIdx = button.getAttribute('data-extra-idx');
      if (tool) {
        // Check if this is an alias group (has details row)
        const detailsRow = document.getElementById(`details-${tool}`) as HTMLElement | null;
        
        if (detailsRow) {
          const isHidden = detailsRow.classList.contains('hidden');
          // toggle chevron
          button.classList.toggle('codicon-chevron-right', !isHidden);
          button.classList.toggle('codicon-chevron-down', isHidden);
          
          // Toggle details row
          if (isHidden) {
            detailsRow.classList.remove('hidden');
          } else {
            detailsRow.classList.add('hidden');
          }
          
          // Also toggle all variant rows if they exist
          const variantRows = document.querySelectorAll(`.alias-variant-row`);
          variantRows.forEach(row => {
            // Check if this variant belongs to current alias
            const rowId = row.getAttribute('id') || '';
            if (rowId.includes(tool) || row.previousElementSibling?.getAttribute('id')?.startsWith('details-' + tool)) {
              if (isHidden) {
                row.classList.remove('hidden');
              } else {
                row.classList.add('hidden');
              }
            }
          });
          
          // Lazy fill placeholder content if empty
          const container = document.getElementById(`details-content-${tool}`) as HTMLElement | null;
          if(container && container.childElementCount > 0 && container.querySelector('.grid-group-div')) {
            // Already has content, skip
          } else if (container) {
            const input = document.getElementById(`details-path-input-${tool}`) as HTMLInputElement | null;
            const path = input?.value ?? '';
            if (!path || path === 'empty') {
              // Content already generated in HTML
            }
          }
        }
      } else if (extraIdx) {
        const row = document.getElementById(`extra-details-${extraIdx}`) as HTMLElement | null;
        if (!row) return;
        const isHidden = row.classList.contains('hidden');
        button.classList.toggle('codicon-chevron-right', !isHidden);
        button.classList.toggle('codicon-chevron-down', isHidden);
        if (isHidden) {
          row.classList.remove('hidden');
        } else {
          row.classList.add('hidden');
        }
      }
    });
    // ensure chevron reflects initial state (hidden by default)
    button.classList.add('codicon-chevron-right');
    button.classList.remove('codicon-chevron-down');
  });

  // Save path by text input or browse button: send the value to backend
  document.addEventListener('click', async (e) => {
    if (!e.target) return;
    const btn = (e.target as HTMLElement).closest('.save-path-button');
    if (!btn) return;
    const tool = btn.getAttribute('data-tool');
    const input = document.getElementById(`details-path-input-${tool}`) as HTMLInputElement | null;
    const browseBtn = document.getElementById(`browse-path-button-${tool}`) as HTMLButtonElement | null;
    const checkbox = document.querySelector(`.add-to-path[data-tool="${tool}"]`) as HTMLInputElement | null;

    if (!input || !browseBtn || !checkbox) return;

    if (btn.textContent === 'Edit') {
      input.disabled = false;
      browseBtn.disabled = false;
      checkbox.disabled = false; 
      input.focus();
      btn.textContent = 'Done';
    } else if (btn.textContent === 'Done') {
      input.disabled = true;
      browseBtn.disabled = true;
      checkbox.disabled = true;
      btn.textContent = 'Edit';
      // Save the new path
      webviewApi.postMessage({ command: 'update-path', tool, newPath: input.value, addToPath: checkbox.checked  });
    }
  });

  // Main Runners: Save the new path when Enter is pressed in the text field  
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const active = document.activeElement as HTMLInputElement | null;
      if (active && active.classList.contains('details-path-field') && !active.disabled) {
        const tool = active.id.replace('details-path-input-', '');
        const btn = document.querySelector(`.save-path-button[data-tool="${tool}"]`) as HTMLElement | null;
        if (btn && btn.textContent === 'Done') {
          btn.click();
        }
      }
    }
  });

  // Extra Runners: Save the new path when Enter is pressed in the text field  
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const active = document.activeElement as HTMLInputElement | null;
    if (!active || active.disabled) return;

    // Check if the active element is one of the extra path inputs
    if (active.id && active.id.startsWith('extra-path-input-')) {
      e.preventDefault();
      e.stopPropagation();
      const idx = active.id.replace('extra-path-input-', '');
      const btn = document.getElementById(`edit-extra-path-btn-${idx}`) as HTMLButtonElement | null;
      if (btn && btn.textContent === 'Done') {
        btn.click();
      }
    }
  });

  // Add new extra runner path button and insert a new editable row locally
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const addBtn = target.closest('#add-extra-path-btn') as HTMLElement | null;
    if (!addBtn) return;
    e.preventDefault();
    e.stopPropagation();

    // Determine next index based on current rows
    const inputs = Array.from(document.querySelectorAll('[id^="extra-path-input-"]')) as HTMLElement[];
    const usedIdx = inputs
      .map(el => Number((el.id || '').replace('extra-path-input-', ''))) 
      .filter(n => Number.isInteger(n) && n >= 0);
    const nextIdx = usedIdx.length ? Math.max(...usedIdx) + 1 : 0;

    // Build details row HTML with input enabled and button set to Done
    const rowHtml = `
      <tr id="extra-details-${nextIdx}" class="details-row extra-details-row">
        <td></td>
        <td colspan="5">
          <div id="extra-details-content-${nextIdx}" class="details-content">
            <div class="grid-group-div extra-grid-group">
              <vscode-text-field id="extra-path-input-${nextIdx}" class="details-path-field" value="" size="50">New Path:</vscode-text-field>
              <vscode-button id="browse-extra-path-button-${nextIdx}" class="browse-extra-input-button" appearance="secondary">
                <span class="codicon codicon-folder"></span>
              </vscode-button>
              <vscode-button id="edit-extra-path-btn-${nextIdx}" class="edit-extra-path-button save-path-button" appearance="primary">Done</vscode-button>
              <vscode-button id="remove-extra-path-btn-${nextIdx}" class="remove-extra-path-button" appearance="secondary" disabled>Remove</vscode-button>
            </div>
          </div>
        </td>
      </tr>`;

    const addRow = (addBtn as HTMLElement).closest('tr');
    const tbody = addRow?.parentElement;
    if (!tbody) return;
    const temp = document.createElement('tbody');
    temp.innerHTML = rowHtml.trim();
    const newRow = temp.firstElementChild as HTMLElement;
    tbody.insertBefore(newRow, addRow!);

    // Focus input immediately
    const input = document.getElementById(`extra-path-input-${nextIdx}`) as HTMLInputElement | null;
    if (input) {
      // ensure enabled
      (input as any).disabled = false;
      input.focus();
    }

    // Set button to Done state explicitly 
    const btn = document.getElementById(`edit-extra-path-btn-${nextIdx}`) as HTMLButtonElement | null;
    if (btn) btn.textContent = 'Done';

    // Enable remove button
    const removeBtn = document.getElementById(`remove-extra-path-btn-${nextIdx}`) as HTMLButtonElement | null;
    if (removeBtn) removeBtn.removeAttribute('disabled');
  });

  // Browse path button: open folder picker
  document.querySelectorAll('.browse-input-button').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).id; 
      const tool = id.replace('browse-path-button-', '');
      if (!tool) return;
      const checkbox = document.querySelector(`.add-to-path[data-tool="${tool}"]`) as HTMLInputElement | null;
      const addToPath = checkbox ? checkbox.checked : undefined;
      webviewApi.postMessage({ command: 'browse-path', tool, addToPath });
    });
  });

  // Browse extra runner path (event delegation)
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const browseBtn = target.closest('.browse-extra-input-button') as HTMLElement | null;
    if (!browseBtn) return;
    const id = browseBtn.id || '';
    const idx = id.replace('browse-extra-path-button-', '');
    if (idx === '') return;
    webviewApi.postMessage({ command: 'browse-extra-path', idx });
  });

  // Toggle Add to PATH: use event delegation so dynamically-updated rows still work
  document.addEventListener('change', (ev) => {
    const target = ev.target as any;
    if (!target) return;
    if (!target.classList.contains('add-to-path')) return;
    const tool = target.getAttribute('data-tool');
    if (!tool) return;
    const addToPath = target.checked; 
    webviewApi.postMessage({ command: 'toggle-add-to-path', tool, addToPath });
  });
}

function setVSCodeMessageListener() {
  window.addEventListener("message", (event) => {
    const command = event.data.command;
    switch(command) {
      case 'exec-done': {
        const progress = document.getElementById(`progress-${event.data.tool}`) as HTMLElement;
        progress.style.display = 'none';
        // Keep legacy per-tool detect for immediate feedback
        webviewApi.postMessage({ command: 'detect', tool: event.data.tool });
        break;
      }
      case 'exec-install-finished': {
        // Clear all versions and statuses, then ask backend to refresh all
        document.querySelectorAll('[id^="version-"]').forEach(el => { (el as HTMLElement).textContent = ''; });
        document.querySelectorAll('[id^="detect-"]').forEach(el => { (el as HTMLElement).textContent = ''; });
        webviewApi.postMessage({ command: 'refresh-all' });
        break;
      }
      case 'detect-done': {
        console.log(event.data.tool);
        console.log(event.data.version);
        const versionCell = document.getElementById(`version-${event.data.tool}`) as HTMLElement;
        const statusCell = document.getElementById(`detect-${event.data.tool}`) as HTMLElement;
        if (typeof event.data.status === 'string') {
          statusCell.textContent = event.data.status;
          versionCell.textContent = event.data.status === 'Not installed' ? '' : (event.data.version || '');
        } else if(event.data.version !== '') {
          versionCell.textContent = event.data.version;
          statusCell.textContent = 'Installed';
        } else {
          versionCell.textContent = '';
          statusCell.textContent = 'Not installed';
        }
        break;
      }
      case 'path-updated': {
        const { tool, path, success, FromBrowse } = event.data;
        // Get input field for path
        const input = document.getElementById(`details-path-input-${tool}`) as HTMLInputElement | null;
        // Get browse button for path
        const browseBtn = document.getElementById(`browse-path-button-${tool}`) as HTMLButtonElement | null;
        const checkbox = document.querySelector(`.add-to-path[data-tool="${tool}"]`) as HTMLInputElement | null;

        if (input) {
          input.value = path ?? '';
          input.disabled = true;
        }
        if (browseBtn) {
          browseBtn.disabled = true;
        }
        if (checkbox) {
          // After saving path via Browse, disable checkbox
          checkbox.disabled = true;
          // If this is the first time via Browse, send update-path with checkbox value
          if (FromBrowse) {
            webviewApi.postMessage({
              command: 'update-path',
              tool,
              newPath: path,
              addToPath: checkbox.checked
            });
          }
        }

        // Get save/edit button
        const btn = document.querySelector(`.save-path-button[data-tool="${tool}"]`) as HTMLButtonElement | null;
        if (btn) {
          btn.textContent = 'Edit';
          btn.removeAttribute('disabled');
        }
        break;
      }
      case 'add-to-path-updated': {
        const { tool, doNotUse } = event.data;
        const cb = document.querySelector(`.add-to-path[data-tool="${tool}"]`) as HTMLInputElement | null;
        // doNotUse true => checkbox unchecked (do_not_use=true means do NOT add to PATH)
        if (cb) { cb.checked = !doNotUse; }
        break;
      }
      case 'extra-path-updated': {
        const { idx, path, success } = event.data;
        const input = document.getElementById(`extra-path-input-${idx}`) as HTMLInputElement | null;
        const btn = document.getElementById(`edit-extra-path-btn-${idx}`) as HTMLButtonElement | null;
        const browse = document.getElementById(`browse-extra-path-button-${idx}`) as HTMLButtonElement | null;
        const remove = document.getElementById(`remove-extra-path-btn-${idx}`) as HTMLButtonElement | null;
        if (success) {
          if (input) { input.value = path ?? ''; input.disabled = true; }
          if (btn) { btn.textContent = 'Edit'; }
          if (browse) { browse.setAttribute('disabled', 'true'); }
          if (remove) { remove.setAttribute('disabled', 'true'); }
        }
        break;
      }
      case 'extra-path-removed': {
        const { idx, success } = event.data;
        if (success) {
          const row = document.getElementById(`extra-row-${idx}`);
          const details = document.getElementById(`extra-details-${idx}`);
          if (row && row.parentElement) row.parentElement.removeChild(row);
          if (details && details.parentElement) details.parentElement.removeChild(details);
        }
        break;
      }
      case 'add-extra-path-done': {
        const idx = event.data.idx;
        setTimeout(() => {
          const input = document.getElementById(`extra-path-input-${idx}`) as HTMLInputElement | null;
          const btn = document.getElementById(`edit-extra-path-btn-${idx}`) as HTMLButtonElement | null;
          if (input && btn) {
            input.disabled = false;
            input.focus();
            btn.textContent = 'Done';
          }
        }, 100);
        break;
      }
    }
  });
}

// Event delegation for Extra Runners: Edit/Done and Remove actions
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  // Edit/Done for extra path
  const editBtn = target.closest('.edit-extra-path-button') as HTMLButtonElement | null;
  if (editBtn) {
    const id = editBtn.id; // edit-extra-path-btn-<idx>
    const idx = id.replace('edit-extra-path-btn-', '');
    const input = document.getElementById(`extra-path-input-${idx}`) as HTMLInputElement | null;
    const browse = document.getElementById(`browse-extra-path-button-${idx}`) as HTMLButtonElement | null;
    const remove = document.getElementById(`remove-extra-path-btn-${idx}`) as HTMLButtonElement | null;
    if (!input) return;
    if (editBtn.textContent === 'Edit') {
      input.disabled = false;
      input.focus();
      editBtn.textContent = 'Done';
      // Enable Remove only while in Edit mode
      if (browse) browse.removeAttribute('disabled');
      if (remove) remove.removeAttribute('disabled');
      return;
    }
    if (editBtn.textContent === 'Done') {
      // Still enable remove button when path is empty 
      if (browse) browse.setAttribute('disabled', 'true');
      if (remove) remove.setAttribute('enabled', 'true');
      // Clean the UI but not remove the content on the env.yml
      if (input.value.trim() !== '') {
        webviewApi.postMessage({ command: 'update-extra-path', idx, newPath: input.value });
      }
      else if (input.value.trim() === '') {
        webviewApi.postMessage({ command: 'update-extra-path', idx, newPath: input.value });
      }
      return;
    }
  }
  // Remove extra path
  const removeBtn = target.closest('.remove-extra-path-button') as HTMLButtonElement | null;
  if (removeBtn) {
    if (removeBtn.hasAttribute('disabled')) { return; }
    const idx = removeBtn.getAttribute('data-extra-idx') || removeBtn.id.replace('remove-extra-path-btn-', '');
    if (!idx) return;
    // If input is empty, just remove the row locally without notifying backend
    const input = document.getElementById(`extra-path-input-${idx}`) as HTMLInputElement | null;
    const detailsRow = document.getElementById(`extra-details-${idx}`);
    if (input && input.value.trim() === '') {
      if (detailsRow && detailsRow.parentElement) detailsRow.parentElement.removeChild(detailsRow);
      webviewApi.postMessage({ command: 'remove-extra-path', idx });
      return;
    }
    webviewApi.postMessage({ command: 'remove-extra-path', idx });
    return;
  }
});
