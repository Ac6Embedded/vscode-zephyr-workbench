import { allComponents, provideVSCodeDesignSystem } from "@vscode/webview-ui-toolkit/";

provideVSCodeDesignSystem().register(allComponents);

const webviewApi = acquireVsCodeApi();

window.addEventListener("load", main);

function main() {
  setVSCodeMessageListener();

  // Expand/collapse details
  const expandButtons = document.querySelectorAll('.expand-button');
  expandButtons.forEach(button => {
    button.addEventListener('click', () => {
      const tool = button.getAttribute('data-tool');
      const extraIdx = button.getAttribute('data-extra-idx');
      if (tool) {
        const row = document.getElementById(`details-${tool}`) as HTMLElement | null;
        if (!row) return;
        const isHidden = row.classList.contains('hidden');
        button.classList.toggle('codicon-chevron-right', !isHidden);
        button.classList.toggle('codicon-chevron-down', isHidden);
        const container = document.getElementById(`details-content-${tool}`) as HTMLElement | null;
        if (container && container.childElementCount === 0) {
          const input = document.getElementById(`details-path-input-${tool}`) as HTMLInputElement | null;
          const path = input?.value ?? '';
          if (path && path !== 'empty') {
            container.innerHTML = `<div class="details-line">Path configured: <strong>${path}</strong></div>`;
          } else {
            container.innerHTML = `<div class="details-line">No path configured for <strong>${tool}</strong>.</div>`;
          }
        }
        if (isHidden) {
          row.classList.remove('hidden');
        } else {
          row.classList.add('hidden');
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
    button.classList.add('codicon-chevron-right');
    button.classList.remove('codicon-chevron-down');
  });

  // Toggle Edit/Done for tool path
  document.addEventListener('click', async (e) => {
    if (!e.target) return;
    const btn = (e.target as HTMLElement).closest('.save-path-button');
    if (!btn) return;
    const tool = btn.getAttribute('data-tool');
    // tool button
    if (tool) {
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
        webviewApi.postMessage({ command: 'update-path', tool, newPath: input.value, addToPath: checkbox.checked });
        // Refresh versions when Done is pressed
        document.querySelectorAll('td[id^="version-"]').forEach((el) => {
          (el as HTMLElement).textContent = '';
        });
        webviewApi.postMessage({ command: 'refresh-versions' });
      }
    }
  });

  // Top action buttons
  const btnReinstall = document.getElementById('btn-reinstall-host-tools');
  if (btnReinstall) {
    btnReinstall.addEventListener('click', () => {
      webviewApi.postMessage({ command: 'reinstall-host-tools' });
    });
  }

  const btnRefreshVersions = document.getElementById('btn-refresh-versions');
  if (btnRefreshVersions) {
    btnRefreshVersions.addEventListener('click', () => {
      // Clear all version cells before requesting a refresh
      document.querySelectorAll('td[id^="version-"]').forEach((el) => {
        (el as HTMLElement).textContent = '';
      });
      webviewApi.postMessage({ command: 'refresh-versions' });
    });
  }

  // Environment variables section
  const addEnvBtn = document.getElementById('add-env-var-btn');
  if (addEnvBtn) {
    addEnvBtn.addEventListener('click', () => {
      webviewApi.postMessage({ command: 'add-env-var' });
    });
  }

  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const editBtn = target.closest('.edit-env-button') as HTMLButtonElement | null;
    if (editBtn) {
      const id = editBtn.id; // edit-env-btn-<idx>
      const idx = id.replace('edit-env-btn-', '');
      const nameInput = document.getElementById(`env-name-input-${idx}`) as HTMLInputElement | null;
      const valueInput = document.getElementById(`env-value-input-${idx}`) as HTMLInputElement | null;
      const prevKey = editBtn.getAttribute('data-prev-key') || '';
      if (!nameInput || !valueInput) return;
      const removeBtn = document.getElementById(`remove-env-btn-${idx}`) as HTMLButtonElement | null;
      if (editBtn.textContent === 'Edit') {
        nameInput.disabled = false;
        valueInput.disabled = false;
        nameInput.focus();
        editBtn.textContent = 'Done';
        if (removeBtn) removeBtn.removeAttribute('disabled');
        return;
      }
      if (editBtn.textContent === 'Done') {
        nameInput.disabled = true;
        valueInput.disabled = true;
        editBtn.textContent = 'Edit';
        if (removeBtn) removeBtn.setAttribute('disabled', 'true');
        webviewApi.postMessage({
          command: 'update-env-var',
          idx,
          prevKey,
          newKey: nameInput.value,
          newValue: valueInput.value,
        });
        // Refresh versions when Done is pressed
        document.querySelectorAll('td[id^="version-"]').forEach((el) => {
          (el as HTMLElement).textContent = '';
        });
        webviewApi.postMessage({ command: 'refresh-versions' });
        return;
      }
    }
    const removeBtn = target.closest('.remove-env-button') as HTMLButtonElement | null;
    if (removeBtn) {
      if (removeBtn.hasAttribute('disabled')) return;
      const idx = removeBtn.getAttribute('data-env-idx') || removeBtn.id.replace('remove-env-btn-', '');
      const key = removeBtn.getAttribute('data-key') || '';
      webviewApi.postMessage({ command: 'remove-env-var', idx, key });
      return;
    }
  });
  const btnVerify = document.getElementById('btn-verify-host-tools');
  if (btnVerify) {
    btnVerify.addEventListener('click', () => {
      webviewApi.postMessage({ command: 'verify-host-tools' });
    });
  }
  const btnReinstallVenv = document.getElementById('btn-reinstall-venv');
  if (btnReinstallVenv) {
    btnReinstallVenv.addEventListener('click', () => {
      webviewApi.postMessage({ command: 'reinstall-venv' });
    });
  }

  // Save on Enter for main tools
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const active = document.activeElement as HTMLInputElement | null;
      if (active && active.classList.contains('details-path-field') && !active.disabled && active.id.startsWith('details-path-input-')) {
        const tool = active.id.replace('details-path-input-', '');
        const btn = document.querySelector(`.save-path-button[data-tool="${tool}"]`) as HTMLElement | null;
        if (btn && btn.textContent === 'Done') {
          btn.click();
        }
      }
    }
  });

  // Browse folder for tool path
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

  // Toggle Add to PATH (frontend only until save)
  document.addEventListener('change', (ev) => {
    const target = ev.target as any;
    if (!target) return;
    if (!target.classList.contains('add-to-path')) return;
    const tool = target.getAttribute('data-tool');
    if (!tool) return;
    const addToPath = target.checked;
    webviewApi.postMessage({ command: 'toggle-add-to-path', tool, addToPath });
  });

  // Extra Tools: add via backend and auto-open the new row
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.id !== 'add-extra-path-btn') return;
    e.preventDefault();
    e.stopPropagation();
    webviewApi.postMessage({ command: 'add-extra-path' });
  });

  // Save on Enter for extra paths
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const active = document.activeElement as HTMLInputElement | null;
    if (!active || active.disabled) return;
    if (active.id && active.id.startsWith('extra-path-input-')) {
      e.preventDefault();
      e.stopPropagation();
      const idx = active.id.replace('extra-path-input-', '');
      const btn = document.getElementById(`edit-extra-path-btn-${idx}`) as HTMLButtonElement | null;
      if (btn && btn.textContent === 'Done') btn.click();
    }
  });

  // Browse for extra path (event delegation)
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
}

function setVSCodeMessageListener() {
  window.addEventListener('message', (event) => {
    const command = event.data.command;
    switch (command) {
      case 'toggle-spinner': {
        const show = !!event.data.show;
        const sp = document.getElementById('ht-spinner');
        if (sp) {
          if (show) sp.classList.remove('hidden');
          else sp.classList.add('hidden');
        }
        break;
      }
      case 'update-tool-versions': {
        const versions = event.data.versions || {};
        for (const [tool, ver] of Object.entries(versions)) {
          const cell = document.getElementById(`version-${tool}`);
          if (cell) { cell.textContent = String(ver); }
        }
        break;
      }
      case 'path-updated': {
        const { tool, path, FromBrowse, success } = event.data;
        const input = document.getElementById(`details-path-input-${tool}`) as HTMLInputElement | null;
        const browseBtn = document.getElementById(`browse-path-button-${tool}`) as HTMLButtonElement | null;
        const checkbox = document.querySelector(`.add-to-path[data-tool="${tool}"]`) as HTMLInputElement | null;
        if (input) { input.value = path ?? ''; input.disabled = true; }
        if (browseBtn) { browseBtn.disabled = true; }
        if (checkbox) {
          checkbox.disabled = true;
          if (FromBrowse) {
            webviewApi.postMessage({ command: 'update-path', tool, newPath: path, addToPath: checkbox.checked });
          }
        }
        const btn = document.querySelector(`.save-path-button[data-tool="${tool}"]`) as HTMLButtonElement | null;
        if (btn) { btn.textContent = 'Edit'; btn.removeAttribute('disabled'); }
        break;
      }
      case 'add-to-path-updated': {
        const { tool, doNotUse } = event.data;
        const cb = document.querySelector(`.add-to-path[data-tool="${tool}"]`) as HTMLInputElement | null;
        if (cb) cb.checked = !doNotUse;
        break;
      }
      case 'extra-path-updated': {
        const { idx, path, success } = event.data;
        if (success) {
          const input = document.getElementById(`extra-path-input-${idx}`) as HTMLInputElement | null;
          const btn = document.getElementById(`edit-extra-path-btn-${idx}`) as HTMLButtonElement | null;
          const browse = document.getElementById(`browse-extra-path-button-${idx}`) as HTMLButtonElement | null;
          const remove = document.getElementById(`remove-extra-path-btn-${idx}`) as HTMLButtonElement | null;
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
      case 'env-var-updated': {
        const { idx, key, value, success } = event.data;
        if (success) {
          const nameInput = document.getElementById(`env-name-input-${idx}`) as HTMLInputElement | null;
          const valueInput = document.getElementById(`env-value-input-${idx}`) as HTMLInputElement | null;
          const editBtn = document.getElementById(`edit-env-btn-${idx}`) as HTMLButtonElement | null;
          const removeBtn = document.getElementById(`remove-env-btn-${idx}`) as HTMLButtonElement | null;
          if (nameInput) { nameInput.value = key; nameInput.disabled = true; }
          if (valueInput) { valueInput.value = value ?? ''; valueInput.disabled = true; }
          if (editBtn) { editBtn.textContent = 'Edit'; editBtn.setAttribute('data-prev-key', key); }
          if (removeBtn) { removeBtn.setAttribute('data-key', key); removeBtn.setAttribute('disabled', 'true'); }
        }
        break;
      }
      case 'env-var-removed': {
        const { idx, success } = event.data;
        if (success) {
          const row = document.getElementById(`env-row-${idx}`);
          if (row && row.parentElement) row.parentElement.removeChild(row);
        }
        break;
      }
      case 'add-env-var-done': {
        const idx = event.data.idx;
        if (!document.getElementById(`env-row-${idx}`)) {
          const addRow = document.getElementById('add-env-var-btn')?.closest('tr');
          const tbody = addRow?.parentElement;
          if (tbody && addRow) {
            const rowHtml = `
              <tr id="env-row-${idx}">
                <td class="env-name"><vscode-text-field id="env-name-input-${idx}" class="env-input" value="" placeholder="Name" size="30"></vscode-text-field></td>
                <td class="env-value"><vscode-text-field id="env-value-input-${idx}" class="env-input" value="" placeholder="Value" size="50"></vscode-text-field></td>
                <td class="env-actions-cell">
                  <div class="env-actions">
                    <vscode-button id="edit-env-btn-${idx}" class="edit-env-button" appearance="primary" data-prev-key="">Done</vscode-button>
                    <vscode-button id="remove-env-btn-${idx}" class="remove-env-button" appearance="secondary" data-env-idx="${idx}" data-key="">Remove</vscode-button>
                  </div>
                </td>
              </tr>`;
            const temp = document.createElement('tbody');
            temp.innerHTML = rowHtml.trim();
            const first = temp.firstElementChild as HTMLElement;
            tbody.insertBefore(first, addRow);
            const nameInput = document.getElementById(`env-name-input-${idx}`) as HTMLInputElement | null;
            if (nameInput) nameInput.focus();
          }
        }
        break;
      }
      case 'add-extra-path-done': {
        const idx = event.data.idx;
        // If rows for this index don't exist yet, create them dynamically
        if (!document.getElementById(`extra-row-${idx}`)) {
          const addRow = document.getElementById('add-extra-path-btn')?.closest('tr');
          const tbody = addRow?.parentElement;
          if (tbody && addRow) {
            const summaryHtml = `
              <tr id="extra-row-${idx}">
                <td>
                  <button type="button" class="inline-icon-button expand-button codicon codicon-chevron-down" data-extra-idx="${idx}" aria-label="Expand/Collapse"></button>
                </td>
                <td>Current Path: </td>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
              </tr>`;
            const detailsHtml = `
              <tr id="extra-details-${idx}" class="details-row extra-details-row">
                <td></td>
                <td colspan="5">
                  <div id="extra-details-content-${idx}" class="details-content">
                    <div class="grid-group-div extra-grid-group">
                      <vscode-text-field id="extra-path-input-${idx}" class="details-path-field" value="" size="50">New Path:</vscode-text-field>
                      <vscode-button id="browse-extra-path-button-${idx}" class="browse-extra-input-button" appearance="secondary">
                        <span class="codicon codicon-folder"></span>
                      </vscode-button>
                      <vscode-button id="edit-extra-path-btn-${idx}" class="edit-extra-path-button save-path-button" appearance="primary">Done</vscode-button>
                      <vscode-button id="remove-extra-path-btn-${idx}" class="remove-extra-path-button" appearance="secondary" disabled>Remove</vscode-button>
                    </div>
                  </div>
                </td>
              </tr>`;
            const temp = document.createElement('tbody');
            temp.innerHTML = (summaryHtml + detailsHtml).trim();
            const first = temp.firstElementChild as HTMLElement;
            const second = first?.nextElementSibling as HTMLElement | null;
            tbody.insertBefore(first, addRow);
            if (second) tbody.insertBefore(second, addRow);

            // Attach expand toggle for this new row
            const expandBtn = document.querySelector(`#extra-row-${idx} .expand-button`) as HTMLElement | null;
            if (expandBtn) {
              expandBtn.addEventListener('click', () => {
                const row = document.getElementById(`extra-details-${idx}`) as HTMLElement | null;
                if (!row) return;
                const isHidden = row.classList.contains('hidden');
                expandBtn.classList.toggle('codicon-chevron-right', !isHidden);
                expandBtn.classList.toggle('codicon-chevron-down', isHidden);
                if (isHidden) row.classList.remove('hidden'); else row.classList.add('hidden');
              });
            }
          }
        }
        // Put the row in edit mode and focus
        setTimeout(() => {
          const details = document.getElementById(`extra-details-${idx}`);
          if (details) details.classList.remove('hidden');
          const input = document.getElementById(`extra-path-input-${idx}`) as HTMLInputElement | null;
          const btn = document.getElementById(`edit-extra-path-btn-${idx}`) as HTMLButtonElement | null;
          const remove = document.getElementById(`remove-extra-path-btn-${idx}`) as HTMLButtonElement | null;
          if (input) { (input as any).disabled = false; input.focus(); }
          if (btn) { btn.textContent = 'Done'; }
          if (remove) { remove.removeAttribute('disabled'); }
        }, 50);
        break;
      }
    }
  });
}

// Event delegation for Extra Tools edit/remove
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const editBtn = target.closest('.edit-extra-path-button') as HTMLButtonElement | null;
    if (editBtn) {
      const id = editBtn.id;
      const idx = id.replace('edit-extra-path-btn-', '');
      const input = document.getElementById(`extra-path-input-${idx}`) as HTMLInputElement | null;
      const browse = document.getElementById(`browse-extra-path-button-${idx}`) as HTMLButtonElement | null;
      const remove = document.getElementById(`remove-extra-path-btn-${idx}`) as HTMLButtonElement | null;
      if (!input) return;
      if (editBtn.textContent === 'Edit') {
        input.disabled = false;
        input.focus();
        editBtn.textContent = 'Done';
        if (browse) browse.removeAttribute('disabled');
        if (remove) remove.removeAttribute('disabled');
        return;
      }
      if (editBtn.textContent === 'Done') {
        if (browse) browse.setAttribute('disabled', 'true');
        if (remove) remove.setAttribute('enabled', 'true');
        webviewApi.postMessage({ command: 'update-extra-path', idx, newPath: input.value });
        // Refresh versions when Done is pressed
        document.querySelectorAll('td[id^="version-"]').forEach((el) => {
          (el as HTMLElement).textContent = '';
        });
        webviewApi.postMessage({ command: 'refresh-versions' });
        return;
      }
    }
  const removeBtn = target.closest('.remove-extra-path-button') as HTMLButtonElement | null;
  if (removeBtn) {
    if (removeBtn.hasAttribute('disabled')) return;
    const idx = removeBtn.getAttribute('data-extra-idx') || removeBtn.id.replace('remove-extra-path-btn-', '');
    if (!idx) return;
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
