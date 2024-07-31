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
  soc!: string;
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
  }

  get rootPath(): string {
    return path.dirname(this.yamlFileUri.fsPath);
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

}