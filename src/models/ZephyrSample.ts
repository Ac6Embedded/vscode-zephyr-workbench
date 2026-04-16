import vscode from "vscode";

export type ZephyrAppTemplateKind = 'sample' | 'test';

export class ZephyrSample {
  constructor(
    public readonly name: string, 
    public readonly rootDir: vscode.Uri,
    public readonly kind: ZephyrAppTemplateKind) 
  {

  }
}
