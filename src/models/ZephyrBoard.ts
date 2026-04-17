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
  revisionFormat?: string;
  defaultRevision?: string;
  exactRevisionMatch?: boolean;
  availableRevisions: string[] = [];
  
  readonly yamlFileUri: vscode.Uri ;

  public constructor(yamlFileUri: vscode.Uri, identifierOverride?: string) {
    this.yamlFileUri = yamlFileUri;
    this.parseYAML();
    if (identifierOverride) {
      this.identifier = identifierOverride;
    }
    try {
      this.parseBoardTerm();
    } catch(e) {

    }
    this.parseBoardMetadata();
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

  private parseBoardMetadata() {
    try {
      const boardYmlPath = this.boardYMLPath;
      if (!fs.existsSync(boardYmlPath)) {
        return;
      }

      const boardYml = fs.readFileSync(boardYmlPath, 'utf8');
      const data = yaml.parse(boardYml);
      const revision = data?.board?.revision;

      this.revisionFormat = typeof revision?.format === 'string' ? revision.format : undefined;
      this.defaultRevision = typeof revision?.default === 'string' ? revision.default : undefined;
      this.exactRevisionMatch = typeof revision?.exact === 'boolean' ? revision.exact : undefined;
      this.availableRevisions = Array.isArray(revision?.revisions)
        ? revision.revisions
            .map((entry: any) => {
              if (typeof entry === 'string') {
                return entry;
              }
              return typeof entry?.name === 'string' ? entry.name : undefined;
            })
            .filter((entry: string | undefined): entry is string => typeof entry === 'string' && entry.length > 0)
        : [];
    } catch {
      this.availableRevisions = [];
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

  private getIdentifierQualifierSuffix(): string {
    if (!this.identifier) {
      return '';
    }

    const match = this.identifier.match(/^([^@\/]+)(?:@[^\/]+)?(.*)$/);
    return match?.[2] ?? '';
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

  public expandTargets(): ZephyrBoard[] {
    if (this.rev || this.availableRevisions.length === 0 || !this.boardName) {
      return [this];
    }

    const suffix = this.getIdentifierQualifierSuffix();
    const expanded: ZephyrBoard[] = [this];
    const seen = new Set<string>([this.identifier]);

    for (const revision of this.availableRevisions) {
      const identifier = `${this.boardName}@${revision}${suffix}`;
      if (seen.has(identifier)) {
        continue;
      }
      expanded.push(this.withIdentifier(identifier));
      seen.add(identifier);
    }

    return expanded;
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

}
