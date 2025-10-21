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
        container.innerHTML = `<div class=\"details-line\">No path detected for <strong>${tool}</strong>.</div>`;
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

  // Save path button: send the input value to backend
  document.querySelectorAll('.save-path-button').forEach(btn => {
    btn.addEventListener('click', () => {
      const tool = btn.getAttribute('data-tool');
      if (!tool) return;
      const input = document.getElementById(`details-path-input-${tool}`) as HTMLInputElement | null;
      if (!input) return;
      webviewApi.postMessage({ command: 'update-path', tool, newPath: input.value });
    });
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
        const input = document.getElementById(`details-path-input-${tool}`) as HTMLInputElement | null;
        if (input) {
          input.value = path ?? '';
        }
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