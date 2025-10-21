import { Button, Dropdown, DropdownOptions, TextField, allComponents,
    provideVSCodeDesignSystem } from "@vscode/webview-ui-toolkit/";
  
provideVSCodeDesignSystem().register(
allComponents
);

const webviewApi = acquireVsCodeApi();

window.addEventListener("load", main);

function main() {
    setVSCodeMessageListener();

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

  // Expand or collapse details row under the application name
  const expandButtons = document.querySelectorAll('.expand-button');
  expandButtons.forEach(button => {
    button.addEventListener('click', () => {
      const tool = button.getAttribute('data-tool');
      if(!tool) return;
      const row = document.getElementById(`details-${tool}`) as HTMLElement | null;
      if(!row) return;
      const isHidden = row.classList.contains('hidden');
      // toggle chevron
      button.classList.toggle('codicon-chevron-right', !isHidden);
      button.classList.toggle('codicon-chevron-down', isHidden);
      // lazy fill placeholder content if empty
      const container = document.getElementById(`details-content-${tool}`) as HTMLElement | null;
      if(container && container.childElementCount === 0) {
      // Check if the input field is empty or not for the path
        const input = document.getElementById(`details-path-input-${tool}`) as HTMLInputElement | null;
        const path = input?.value ?? '';
        if (path && path !== 'empty') {
          container.innerHTML = `<div class="details-line">Path detected: <strong>${path}</strong></div>`;
        } else {
          container.innerHTML = `<div class="details-line">No path detected for <strong>${tool}</strong>.</div>`;
        }
      }
      if(isHidden) {
        row.classList.remove('hidden');
      } else {
        row.classList.add('hidden');
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

    if (!input || !browseBtn) return;

    if (btn.textContent === 'Edit') {
      input.disabled = false;
      browseBtn.disabled = false;
      input.focus();
      btn.textContent = 'Done';
    } else if (btn.textContent === 'Done') {
      input.disabled = true;
      browseBtn.disabled = true;
      btn.textContent = 'Edit';
      // Save the new path
      webviewApi.postMessage({ command: 'update-path', tool, newPath: input.value });
    }
  });

  // Save the new path when Enter is pressed in the text field  
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

  // Browse path button: open folder picker
  document.querySelectorAll('.browse-input-button').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = (btn as HTMLElement).id; 
      const tool = id.replace('browse-path-button-', '');
      if (!tool) return;
      webviewApi.postMessage({ command: 'browse-path', tool });
    });
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
        webviewApi.postMessage({
          command: 'detect',
          tool: event.data.tool
        });
        break;
      }
      case 'detect-done': {
        console.log(event.data.tool);
        console.log(event.data.version);
        const versionCell = document.getElementById(`version-${event.data.tool}`) as HTMLElement;
        const statusCell = document.getElementById(`detect-${event.data.tool}`) as HTMLElement;
        versionCell.textContent = event.data.version;
        if(event.data.version !== '') {
          statusCell.textContent = 'Installed';
        } else {
          statusCell.textContent = 'Not installed';
        }
        break;
      }
      case 'path-updated': {
        const { tool, path, saved } = event.data;
        
        // Get input field for path
        const input = document.getElementById(`details-path-input-${tool}`) as HTMLInputElement | null;
        // Get browse button for path
        const browseBtn = document.getElementById(`browse-path-button-${tool}`) as HTMLButtonElement | null;

        if (input) {
          input.value = path ?? ''; // Update input value with new path
          input.disabled = true; // Disable input after update
        }
        if (browseBtn) {
        browseBtn.disabled = true; // Disable browse button after update
        }

        // Get save/edit button
        const btn = document.querySelector(`.save-path-button[data-tool="${tool}"]`) as HTMLButtonElement | null;
        if (btn) {
          if (saved && path && path.length > 0) {
            // After changing the path, show Done and disable the button
            btn.textContent = 'Done';
            btn.setAttribute('disabled', '');
          } else {
            btn.textContent = 'Edit';
            btn.removeAttribute('disabled');
          }
        }
        break;
      }
      case 'add-to-path-updated': {
        const { tool, doNotUse } = event.data;
        const cb = document.querySelector(`.add-to-path-checkbox[data-tool="${tool}"]`) as HTMLInputElement | null;
        // doNotUse true => checkbox unchecked (do_not_use=true means do NOT add to PATH)
        if (cb) { cb.checked = !doNotUse; }
        break;
      }
    }
  });
}