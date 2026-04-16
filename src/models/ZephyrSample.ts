import vscode from "vscode";

export class ZephyrSample {
  constructor(
    public readonly name: string, 
    public readonly rootDir: vscode.Uri) 
  {

  }
}
