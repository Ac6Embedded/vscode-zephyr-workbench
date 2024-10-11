import vscode from "vscode";
import fs from "fs";
import yaml from 'yaml';
import path from "path";

export class ZephyrBoard {
  identifier!: string;
  name!: string;
  vendor!: string;
  type!: string;
  arch!: string;
  supported!: string[];
  socs!: string[];
  readonly yamlFileUri: vscode.Uri ;

  public constructor(yamlFileUri: vscode.Uri) {
    this.yamlFileUri = yamlFileUri;
    this.parseYAML();
  }

  private parseYAML() {
    // TODO parse boardname.yaml file to get more information on board
    if(this.yamlFileUri) {
      const boardFile = fs.readFileSync(this.yamlFileUri.fsPath, 'utf8');
      const data = yaml.parse(boardFile);
      this.identifier = data.identifier;
      this.name = data.name;
      this.vendor = data.vendor;
      this.type = data.type;
      this.arch = data.arch;
      this.supported = data.supported;
    }

    if(fs.existsSync(this.boardYMLPath)) {
      const boardFile2 = fs.readFileSync(this.boardYMLPath, 'utf8');
      const data = yaml.parse(boardFile2);
      this.socs = data.board.socs;
    }
  }

  get rootPath(): string {
    return path.dirname(this.yamlFileUri.fsPath);
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
    return path.join(this.docDirPath, 'img', `${this.identifier}.jpg`);
  }

  get readmePath(): string {
    return path.join(this.docDirPath, 'index.rst');
  }

  public getCompatibleRunners(): string[] {
    let runners: string[] = [];
    const boardCMakePath = path.join(this.rootPath, 'board.cmake');
    const data = fs.readFileSync(boardCMakePath, 'utf-8');

    const regex = /include\(\$\{ZEPHYR_BASE\}\/boards\/common\/(.*)\.board\.cmake\)/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(data)) !== null) {
      runners.push(match[1]);
    }

    return runners;
  }

}