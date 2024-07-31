import vscode from "vscode";
import fs from "fs";
import yaml from 'yaml';

export class ZephyrSample {
  constructor(
    public readonly name: string, 
    public readonly rootDir: vscode.Uri) 
  {

  }
}