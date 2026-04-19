import vscode from "vscode";
import fs from "fs";
import yaml from 'yaml';
import path from "path";

export class ZephyrBoard {
  identifier!: string;
  name!: string;
  boardName!: string; /* Real parent board name NOTE: Zephyr board concept is boardname[@revision][/SoC[/CPU cluster][/variant]] */
  rev!: string;
  soc!: string;
  cpuCluster!: string;
  variant!: string;
  vendor!: string;
  type!: string;
  arch!: string;
  supported!: string[];
  
  readonly rootPath: string;
  readonly yamlFileUri?: vscode.Uri;
  
  public constructor(boardUri: vscode.Uri, identifierOverride?: string) {
    if (boardUri.fsPath.toLowerCase().endsWith('.yaml')) {
      this.yamlFileUri = boardUri;
      this.rootPath = path.dirname(boardUri.fsPath);
    } else {
      this.rootPath = boardUri.fsPath;
      this.yamlFileUri = this.findBoardYamlUri(identifierOverride);
    }

    this.parseYAML();
    if (identifierOverride) {
      this.identifier = identifierOverride;
    }
    try {
      this.parseBoardTerm();
    } catch(e) {

    }
  }

  private parseYAML() {
    if (!this.yamlFileUri) {
      return;
    }

    try {
      const boardFile = fs.readFileSync(this.yamlFileUri.fsPath, 'utf8');
      const data = yaml.parse(boardFile);
      this.identifier = data.identifier;
      this.name = data.name;
      this.vendor = data.vendor;
      this.type = data.type;
      this.arch = data.arch;
      this.supported = data.supported;
    } catch {
      // Keep partial data when the board definition file cannot be read.
    }
  }

  private parseBoardTerm() {
    if(this.identifier) {
      const regex = /^([^@\/]+)(?:@([^\/]+))?(?:\/([^\/]+)(?:\/([^\/]+)(?:\/([^\/]+))?)?)?$/;
      const match = this.identifier.match(regex);
      
      if (!match) {
        throw new Error(`Identifier format invalid for: ${this.identifier}`);
      }

      this.boardName = match[1];
      this.rev = match[2];
      this.soc = match[3];
      this.cpuCluster = match[4];
      this.variant = match[5];
    }
  }

  public withIdentifier(identifier: string): ZephyrBoard {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this)) as ZephyrBoard,
      this,
      {
        identifier,
        boardName: '',
        rev: '',
        soc: '',
        cpuCluster: '',
        variant: '',
      },
    );
    clone.parseBoardTerm();
    return clone;
  }

  get boardYMLPath(): string {
    return path.join(this.rootPath, 'board.yml');
  }

  get docDirPath(): string {
    return path.join(this.rootPath, 'doc');
  }

  get supportDirPath(): string {
    return path.join(this.rootPath, 'support');
  }

  get openocdCfgPath(): string {
    return path.join(this.supportDirPath, 'openocd.cfg');
  }

  get imagePath(): string {
    return path.join(this.docDirPath, 'img', `${this.boardName ?? this.identifier}.jpg`);
  }

  get readmePath(): string {
    return path.join(this.docDirPath, 'index.rst');
  }

  /**
   * Read the first SoC name from the board.yml file.
   * Returns undefined if the file does not exist or has no socs entry.
   */
  public getSocName(): string | undefined {
    try {
      const boardYmlPath = this.boardYMLPath;
      if (!fs.existsSync(boardYmlPath)) {
        return undefined;
      }
      const content = fs.readFileSync(boardYmlPath, 'utf8');
      const data = yaml.parse(content);
      const socs: any[] | undefined = data?.board?.socs;
      if (Array.isArray(socs) && socs.length > 0 && socs[0].name) {
        return socs[0].name;
      }
    } catch {
      // Ignore parse errors
    }
    return undefined;
  }

  public getCompatibleRunners(): string[] {
    try {
      let runners: string[] = [];
      const boardCMakePath = path.join(this.rootPath, 'board.cmake');
      if (!fs.existsSync(boardCMakePath)) {
        return runners;
      }

      const data = fs.readFileSync(boardCMakePath, 'utf-8');

      const regex = /include\(\$\{ZEPHYR_BASE\}\/boards\/common\/(.*)\.board\.cmake\)/g;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(data)) !== null) {
        runners.push(match[1]);
      }

      return runners;
    } catch {
      return [];
    }
  }

  private findBoardYamlUri(identifierOverride?: string): vscode.Uri | undefined {
    try {
      const files = fs.readdirSync(this.rootPath, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.yaml'))
        .map(entry => vscode.Uri.file(path.join(this.rootPath, entry.name)));

      if (files.length === 0) {
        return undefined;
      }

      const preferredIdentifier = identifierOverride
        ? identifierOverride.replace(/^([^@\/]+).*/, '$1')
        : undefined;

      if (preferredIdentifier) {
        for (const file of files) {
          try {
            const data = yaml.parse(fs.readFileSync(file.fsPath, 'utf8'));
            if (data?.identifier === preferredIdentifier) {
              return file;
            }
          } catch {
            // Ignore malformed candidate files and keep scanning.
          }
        }
      }

      return files[0];
    } catch {
      return undefined;
    }
  }

}
