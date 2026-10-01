import vscode from "vscode";
import fs from "fs";
import yaml from 'yaml';
import path from "path";

/**
 * The twister identifier that describes a board target, among the ones a
 * board folder declares in its `<board>.yaml` files. Twister identifiers carry
 * no revision. A board with a single SoC can be named `board` or `board/soc`,
 * and its folder may declare either spelling. Another target's file is never
 * returned: its name and arch would be wrong for this one.
 */
export function matchTwisterIdentifier(target: string, identifiers: ReadonlySet<string>): string | undefined {
  const withoutRevision = target.replace(/^([^@/]+)@[^/]*/, '$1');
  if (identifiers.has(withoutRevision)) {
    return withoutRevision;
  }
  const [board, ...qualifiers] = withoutRevision.split('/');
  if (qualifiers.length === 1) {
    return identifiers.has(board) ? board : undefined;
  }
  if (qualifiers.length === 0) {
    const spelledOut = [...identifiers].filter(identifier => identifier.startsWith(`${board}/`) && identifier.split('/').length === 2);
    return spelledOut.length === 1 ? spelledOut[0] : undefined;
  }
  return undefined;
}

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
      this.applyDefinition(yaml.parse(fs.readFileSync(this.yamlFileUri.fsPath, 'utf8')));
    } catch {
      // Keep partial data when the board definition file cannot be read.
    }
  }

  private applyDefinition(data: any) {
    this.identifier = data.identifier;
    this.name = data.name;
    this.vendor = data.vendor;
    this.type = data.type;
    this.arch = data.arch;
    this.supported = data.supported;
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

  /**
   * Build a board from a manually entered identifier that has no on-disk
   * definition (a custom board that discovery did not surface). rootPath is left
   * empty so path-derived getters do not bind to an unrelated directory; west
   * resolves the identifier against the board roots at build time.
   */
  public static fromIdentifier(identifier: string): ZephyrBoard {
    const board = Object.assign(
      Object.create(ZephyrBoard.prototype) as ZephyrBoard,
      {
        rootPath: '',
        yamlFileUri: undefined,
        identifier,
        boardName: '',
        rev: '',
        soc: '',
        cpuCluster: '',
        variant: '',
      },
    );
    try {
      board.parseBoardTerm();
    } catch {
      // Keep the raw identifier; west validates it when the build runs.
    }
    return board;
  }

  /**
   * A board target of a folder board discovery already read, so nothing is
   * read again: `definition` is the twister file of exactly this target, when
   * the folder has one, and `name` the label to show.
   */
  public static fromDiscovery(
    rootPath: string,
    identifier: string,
    name: string,
    definition?: { file: string; data: Record<string, unknown> },
  ): ZephyrBoard {
    const board = Object.assign(Object.create(ZephyrBoard.prototype) as ZephyrBoard, {
      rootPath,
      yamlFileUri: definition ? vscode.Uri.file(definition.file) : undefined,
    });
    if (definition) {
      board.applyDefinition(definition.data);
    }
    Object.assign(board, { identifier, name });
    try {
      board.parseBoardTerm();
    } catch {
      // Keep the raw identifier, as the constructor does.
    }
    return board;
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
      if (fs.existsSync(boardCMakePath)) {
        const data = fs.readFileSync(boardCMakePath, 'utf-8');

        const regex = /include\(\$\{ZEPHYR_BASE\}\/boards\/common\/(.*)\.board\.cmake\)/g;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(data)) !== null) {
          runners.push(match[1]);
        }
      }

      // Emulator boards register no common .board.cmake include, so the regex
      // above never surfaces the QEMU runner. Add it from the emulator signal.
      if (this.supportsQemu() && !runners.includes('qemu')) {
        runners.push('qemu');
      }

      return runners;
    } catch {
      return [];
    }
  }

  /**
   * Whether this board can be run and debugged under the QEMU emulator. True
   * when the board identifier follows the `qemu_` naming convention, or when its
   * board.cmake lists `qemu` among SUPPORTED_EMU_PLATFORMS (the signal Zephyr
   * uses to enable the `run` / `debugserver_qemu` CMake targets).
   */
  public supportsQemu(): boolean {
    const boardName = this.boardName || this.identifier || '';
    if (boardName.startsWith('qemu_')) {
      return true;
    }

    try {
      const boardCMakePath = path.join(this.rootPath, 'board.cmake');
      if (!fs.existsSync(boardCMakePath)) {
        return false;
      }

      const data = fs.readFileSync(boardCMakePath, 'utf-8');
      const match = data.match(/(?:set|list)\s*\(\s*(?:APPEND\s+)?SUPPORTED_EMU_PLATFORMS\b([^)]*)\)/i);
      if (!match) {
        return false;
      }

      return /\bqemu\b/.test(match[1]);
    } catch {
      return false;
    }
  }

  /**
   * The twister file of the target, or without a target the folder's first
   * one. A target the folder has no file for gets none rather than another
   * target's, whose name and arch would be wrong.
   */
  private findBoardYamlUri(identifierOverride?: string): vscode.Uri | undefined {
    try {
      const files = fs.readdirSync(this.rootPath, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.yaml'))
        .map(entry => entry.name)
        .sort()
        .map(name => vscode.Uri.file(path.join(this.rootPath, name)));

      if (files.length === 0 || !identifierOverride) {
        return files[0];
      }

      const byIdentifier = new Map<string, vscode.Uri>();
      for (const file of files) {
        try {
          const identifier = yaml.parse(fs.readFileSync(file.fsPath, 'utf8'))?.identifier;
          if (typeof identifier === 'string' && !byIdentifier.has(identifier)) {
            byIdentifier.set(identifier, file);
          }
        } catch {
          // Ignore malformed candidate files and keep scanning.
        }
      }
      const match = matchTwisterIdentifier(identifierOverride, new Set(byIdentifier.keys()));
      return match ? byIdentifier.get(match) : undefined;
    } catch {
      return undefined;
    }
  }

}
