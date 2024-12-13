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
      }
    }
  });
}