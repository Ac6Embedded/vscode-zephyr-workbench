import * as vscode from 'vscode';
import * as path from 'path';
import { ZephyrAppProject } from '../models/ZephyrAppProject';
import { getWestWorkspace } from '../utils/utils';
import { ZephyrProjectBuildConfiguration } from '../models/ZephyrProjectBuildConfiguration';
import { ZEPHYR_BUILD_CONFIG_WEST_ARGS_SETTING_KEY } from '../constants';

const EXTRA_ENV_KEYS = ['EXTRA_CONF_FILE', 'EXTRA_DTC_OVERLAY_FILE', 'EXTRA_ZEPHYR_MODULES'];

export class ZephyrApplicationDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | void> = this._onDidChangeTreeData.event;

  constructor() {

	}

  getTreeItem(element: any): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element;
  }

  async getChildren(element?: any): Promise< vscode.TreeItem[] > {
		const items: vscode.TreeItem[] = [];
    if(element === undefined) {
      if(vscode.workspace.workspaceFolders) {
        for(let workspaceFolder of vscode.workspace.workspaceFolders) {
          if(await ZephyrAppProject.isZephyrProjectWorkspaceFolder(workspaceFolder)) {
            const appProject = new ZephyrAppProject(workspaceFolder, workspaceFolder.uri.fsPath);
            const item =  new ZephyrApplicationTreeItem(appProject, vscode.TreeItemCollapsibleState.Collapsed);
            items.push(item);
          }
        }
        return Promise.resolve(items);
      }
    }
    
    if(element instanceof ZephyrApplicationTreeItem) {
      const workspaceItem = new ZephyrApplicationWestWorkspaceTreeItem(element.project);
      items.push(workspaceItem);

      if(element.project.configs.length > 1) {
        for(let config of element.project.configs) {
          const buildConfigItem = new ZephyrConfigTreeItem(element.project, config, vscode.TreeItemCollapsibleState.Collapsed);
          items.push(buildConfigItem);
        }
      } else if(element.project.configs.length === 1) {
        const config = element.project.configs[0];
        const boardItem = new ZephyrConfigBoardTreeItem(element.project, config);
        // Show default runner just under the board when set
        if (config.defaultRunner && config.defaultRunner.length > 0) {
          const runnerItem = new ZephyrConfigDefaultRunnerTreeItem(element.project, config);
          items.push(boardItem, runnerItem);
        } else {
          items.push(boardItem);
        }
        const westArgsItem = new ZephyrConfigArgTreeItem(element.project, config, 'west arguments', config.westArgs, ZEPHYR_BUILD_CONFIG_WEST_ARGS_SETTING_KEY);
        items.push(westArgsItem);
        items.push(new ZephyrConfigExtraEnvTreeItem(element.project, config));

        for(let key of Object.keys(config.envVars)) {
          if (EXTRA_ENV_KEYS.includes(key)) {
            continue;
          }
          let envItem;
          if(Array.isArray(config.envVars[key])) {
            envItem = new ZephyrConfigEnvTreeItem(element.project, config, key);
          } else {
            envItem = new ZephyrConfigArgTreeItem(element.project, config, key, config.envVars[key]);
          }
          items.push(envItem);
        }
      }
      return Promise.resolve(items);
    } 

    if(element instanceof ZephyrConfigTreeItem) {
      const boardItem = new ZephyrConfigBoardTreeItem(element.project, element.buildConfig);
      // Show default runner just under the board when set
      if (element.buildConfig.defaultRunner && element.buildConfig.defaultRunner.length > 0) {
        const runnerItem = new ZephyrConfigDefaultRunnerTreeItem(element.project, element.buildConfig);
        items.push(boardItem, runnerItem);
      } else {
        items.push(boardItem);
      }
      const westArgsItem = new ZephyrConfigArgTreeItem(element.project, element.buildConfig, 'west arguments', element.buildConfig.westArgs, ZEPHYR_BUILD_CONFIG_WEST_ARGS_SETTING_KEY);
      items.push(westArgsItem);
      items.push(new ZephyrConfigExtraEnvTreeItem(element.project, element.buildConfig));

      for(let key of Object.keys(element.buildConfig.envVars)) {
        if (EXTRA_ENV_KEYS.includes(key)) {
          continue;
        }
        let envItem;
        if(Array.isArray(element.buildConfig.envVars[key])) {
          envItem = new ZephyrConfigEnvTreeItem(element.project, element.buildConfig, key);
        } else {
          envItem = new ZephyrConfigArgTreeItem(element.project, element.buildConfig, key, element.buildConfig.envVars[key]);
        }
        items.push(envItem);
      }

      return Promise.resolve(items);
    } 

    if(element instanceof ZephyrApplicationEnvTreeItem) {
      // Get Zephyr environment variables
      let values = element.project.envVars[element.envKey];
      if(values) {
        for(let value of values) {
          const envValueItem = new ZephyrApplicationEnvValueTreeItem(element.project, element.envKey, value);
          items.push(envValueItem);
        }
      }
      
      return Promise.resolve(items);
    } 

    if(element instanceof ZephyrApplicationArgTreeItem) {
      // Get West Argument
      const items: vscode.TreeItem[] = [];
      if(element.project.westArgs && element.project.westArgs.length > 0) {
        const westArgsItem = new ZephyrApplicationArgValueTreeItem(element.project, 'west arguments', element.project.westArgs);
        items.push(westArgsItem);
      } 
      return Promise.resolve(items);
    } 

    if(element instanceof ZephyrConfigExtraEnvTreeItem) {
      for (const key of EXTRA_ENV_KEYS) {
        if (Array.isArray(element.config.envVars[key])) {
          items.push(new ZephyrConfigEnvTreeItem(element.project, element.config, key));
        }
      }
      return Promise.resolve(items);
    }

    if(element instanceof ZephyrConfigEnvTreeItem) {
      // Get Zephyr environment variables
      let values = element.config.envVars[element.envKey];
      if(values) {
        for(let value of values) {
          const envValueItem = new ZephyrConfigEnvValueTreeItem(element.project, element.config, element.envKey, value);
          items.push(envValueItem);
        }
      }
      
      return Promise.resolve(items);
    } 

    if(element instanceof ZephyrConfigArgTreeItem) {
      // Get West Argument
      const items: vscode.TreeItem[] = [];
      if(element.argName === 'west arguments') {
        if(element.config.westArgs && element.config.westArgs.length > 0) {
          const westArgsItem = new ZephyrConfigArgValueTreeItem(element.project, element.config, 'west arguments', element.config.westArgs);
          items.push(westArgsItem);
        } 
      } else {
        if(element.config.envVars[element.argName] && element.config.envVars[element.argName].length > 0) {
          const westArgsItem = new ZephyrConfigArgValueTreeItem(element.project, element.config, element.argName, element.config.envVars[element.argName]);
          items.push(westArgsItem);
        } 
      }

      
      return Promise.resolve(items);
    } 

    return Promise.resolve([]);
  }

  getParent?(element: any): vscode.ProviderResult<vscode.TreeItem> {
    return null;
  }

  resolveTreeItem?(item: vscode.TreeItem, element: ZephyrApplicationTreeItem, token: vscode.CancellationToken): vscode.ProviderResult<vscode.TreeItem> {
    throw new Error('Method not implemented.');
  }

  refresh(): void {
		this._onDidChangeTreeData.fire();
	}

}

export class ZephyrApplicationTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrAppProject,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
	) {
    if(project.sourceDir) {
      super(project.folderName, collapsibleState);
      try {
        let westWorkspace = getWestWorkspace(project.westWorkspacePath);
        if(westWorkspace !== null) {
          this.description = project.configs.length > 0 ? `[with ${westWorkspace.name}]` : `[invalid]`;
          this.contextValue = 'zephyr-application';
        } else {
          this.description = `[not configured]`;
          this.contextValue = 'zephyr-application-not-config';
        }
      } catch(e) {
        console.error(e, " path: ", project.westWorkspacePath);
      }
      this.iconPath = new vscode.ThemeIcon('folder');
      this.tooltip = project.sourceDir;
    }
	}
}

export class ZephyrConfigTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrAppProject,
    public readonly buildConfig: ZephyrProjectBuildConfiguration,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState,
	) {
    if(buildConfig) {
      super(buildConfig.name, collapsibleState);
      this.tooltip = project.sourceDir;

      if(buildConfig.active) {
        this.iconPath = new vscode.ThemeIcon('folder-active');
        this.description = `[${buildConfig.boardIdentifier}] [active]`;
        this.contextValue = 'zephyr-build-config-active';
      } else {
        this.iconPath = new vscode.ThemeIcon('folder');
        this.description = `[${buildConfig.boardIdentifier}] [not active]`;
        this.contextValue = 'zephyr-build-config';
      }
    }
	}
}

export class ZephyrApplicationWestWorkspaceTreeItem extends ZephyrApplicationTreeItem {
  constructor(
		public readonly project: ZephyrAppProject,
	) {
    super(project, vscode.TreeItemCollapsibleState.None);
    let westWorkspace = getWestWorkspace(project.westWorkspacePath);
    if(westWorkspace) {
      this.label = westWorkspace.name;
      this.description = `[${westWorkspace.version}]`;
      this.tooltip = westWorkspace.rootUri.fsPath;
      this.iconPath = {
        light: path.join(__filename, '..', '..', 'res', 'icons', 'zephyr.svg'),
        dark: path.join(__filename, '..', '..', 'res', 'icons', 'zephyr.svg')
      };
    }
	}

  contextValue = 'zephyr-application-workspace';
}

export class ZephyrConfigBoardTreeItem extends vscode.TreeItem {
  constructor(
    public readonly project: ZephyrAppProject,
		public readonly config: ZephyrProjectBuildConfiguration,
	) {
    super(config.boardIdentifier, vscode.TreeItemCollapsibleState.None);
    this.description = '';
    this.tooltip = config.boardIdentifier;
    this.iconPath = new vscode.ThemeIcon('circuit-board');
	}
  
  contextValue = 'zephyr-application-board';
}

export class ZephyrConfigDefaultRunnerTreeItem extends vscode.TreeItem {
  constructor(
    public readonly project: ZephyrAppProject,
    public readonly config: ZephyrProjectBuildConfiguration,
  ) {
    // Label kept short to match existing style; description shows runner
    super('runner', vscode.TreeItemCollapsibleState.None);
    this.description = config.defaultRunner ?? '';
    this.tooltip = `Default runner: ${config.defaultRunner}`;
    this.iconPath = new vscode.ThemeIcon('run');
  }
  contextValue = 'zephyr-application-default-runner';
}

export class ZephyrApplicationEnvTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrAppProject,
    public readonly envKey: string
	) {
    super(envKey, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = project.envVars[envKey].length === 0 ?'[not set]':'';
    this.tooltip = envKey;
    this.iconPath = new vscode.ThemeIcon('variable');
	}
  
  contextValue = 'zephyr-application-env';
}

export class ZephyrConfigExtraEnvTreeItem extends vscode.TreeItem {
  constructor(
    public readonly project: ZephyrAppProject,
    public readonly config: ZephyrProjectBuildConfiguration,
  ) {
    super('EXTRA', vscode.TreeItemCollapsibleState.Collapsed);
    const hasAnyValue = EXTRA_ENV_KEYS.some((key) => Array.isArray(config.envVars[key]) && config.envVars[key].length > 0);
    this.description = hasAnyValue ? '' : '[not set]';
    this.tooltip = 'EXTRA';
    this.iconPath = new vscode.ThemeIcon('variable');
  }
  contextValue = 'zephyr-application-extra';
}

export class ZephyrConfigEnvTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrAppProject,
    public readonly config: ZephyrProjectBuildConfiguration,
    public readonly envKey: string
	) {
    super(envKey, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = config.envVars[envKey].length === 0 ?'[not set]':'';
    this.tooltip = envKey;
    this.iconPath = new vscode.ThemeIcon('variable');
	}
  
  contextValue = 'zephyr-application-env';
}

export class ZephyrApplicationEnvValueTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrAppProject,
    public readonly envKey: string,
    public readonly envValue: string
	) {
    super(envValue, vscode.TreeItemCollapsibleState.None);
	}
  contextValue = 'zephyr-application-env-value';
}

export class ZephyrConfigEnvValueTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrAppProject,
    public readonly config: ZephyrProjectBuildConfiguration,
    public readonly envKey: string,
    public readonly envValue: string
	) {
    super(envValue, vscode.TreeItemCollapsibleState.None);
	}
  contextValue = 'zephyr-application-env-value';
}

export class ZephyrApplicationArgTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrAppProject,
    public readonly argName: string
	) {
    super(argName, vscode.TreeItemCollapsibleState.Collapsed);
    this.description = project.westArgs.length === 0 ?'[not set]':'';
    this.tooltip = argName;
    this.iconPath = new vscode.ThemeIcon('variable');
	}
  contextValue = 'zephyr-application-arg';
}

export class ZephyrConfigArgTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrAppProject,
    public readonly config: ZephyrProjectBuildConfiguration,
    public readonly argName: string,
    public argValue: string,
    public readonly argSetting?: string
	) {
    super(argName, vscode.TreeItemCollapsibleState.Collapsed);
    // if(argName === 'west arguments') {
    //   this.description = ((config.westArgs === undefined) || (config.westArgs.length === 0)) ?'[not set]':'';
    // } else {
    //   this.description = ((config.envVars[argName] === undefined) || (config.envVars[argName].length === 0)) ?'[not set]':'';
    // }
    this.description = ((argValue === undefined) || (argValue.length === 0)) ?'[not set]':'';
    this.tooltip = argName;
    this.iconPath = new vscode.ThemeIcon('variable');
	}
  contextValue = 'zephyr-application-arg';
}

export class ZephyrApplicationArgValueTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrAppProject,
    public readonly argName: string,
    public readonly argValue: string
	) {
    super(argValue, vscode.TreeItemCollapsibleState.None);
	}
  contextValue = 'zephyr-application-arg-value';
}

export class ZephyrConfigArgValueTreeItem extends vscode.TreeItem {
  constructor(
		public readonly project: ZephyrAppProject,
    public readonly config: ZephyrProjectBuildConfiguration,
    public readonly argName: string,
    public readonly argValue: string
	) {
    super(argValue, vscode.TreeItemCollapsibleState.None);
	}
  contextValue = 'zephyr-application-arg-value';
}
