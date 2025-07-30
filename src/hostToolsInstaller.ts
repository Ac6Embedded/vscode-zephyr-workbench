import fs from "fs";
import path from "path";
import { rmSync } from "fs";
import crypto from "crypto";
import { pipeline } from "stream";
import { spawn, execFileSync } from "child_process";
import { promisify } from "util";
import fetch from "node-fetch";
import AdmZip from "adm-zip";
import { path7za } from "7zip-bin";
import YAML from "yaml";
import chalk from "chalk";

const VERSION = "1.0";

const streamPipeline = promisify(pipeline);

if (process.platform !== "win32") {
  console.error("This installer targets Windows only.");
  process.exit(1);
}

function md5(file: string) {
  return crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex");
}

export interface InstallOptions {
  installDir: string;
  portable: boolean;
  onlyCheck: boolean;
  reinstallVenv: boolean;
  log: (text: string) => void;
}
export async function installHostTools(opts: InstallOptions): Promise<void> {
  const { installDir, portable, onlyCheck, reinstallVenv, log } = opts;

  const logger = log ?? console.log;

  const ROOT = path.resolve(installDir, ".zinstaller");
  const TOOLS = path.join(ROOT, "tools");
  const DL = path.join(ROOT, "tmp", "dl");
  const VENV = path.join(ROOT, ".venv");

  process.env.PATH = [
    path.join(TOOLS, "git", "bin"),
    path.join(TOOLS, "cmake", "bin"),
    path.join(TOOLS, "dtc", "usr", "bin"),
    path.join(TOOLS, "gperf", "bin"),
    path.join(TOOLS, "ninja"),
    path.join(TOOLS, "wget"),
    path.join(TOOLS, "7zip"),
    path.join(TOOLS, "python", "python"),
    process.env.PATH
  ].join(path.delimiter);

  const yamlPath = path.resolve(__dirname, "..", "scripts", "hosttools", "tools.yml");
  const yaml = YAML.parse(fs.readFileSync(yamlPath, "utf8"));
  type OsEntry = { source: string | string[]; sha256: string };
  type Section = { tool: string; os: Record<string, OsEntry> };
  const sections: Section[] = [...(yaml.other_content || []), ...(yaml.zephyr_content || [])];
  const windowsTools = sections.filter(t => t.os?.windows);

  const TOOL_ORDER = [
    "wget", "seven_z_portable", "cmake", "ninja", "gperf",
    "zstd", "dtc", "msys2_runtime", "libyaml", "git",
    portable ? "python_portable" : "python"
  ];
  const NEED = new Set(TOOL_ORDER);

  function logLine(msg: string) {
    logger(chalk.cyan("\n" + "-".repeat(40) + "\n" + msg));
  }
  function logLineCentered(msg: string) {
    const width = 40;
    const pad = Math.floor((width - msg.length) / 2);
    const padded = " ".repeat(Math.max(pad, 0)) + msg;
    logger("\n" + "-".repeat(width));
    logger(padded);
    logger("-".repeat(width));
  }
  function sha256(f: string) { return crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"); }

  async function download(url: string, dst: string) {
    if (fs.existsSync(dst)) return;

    logger(chalk.gray(`⇣  ${url}`));
    const res = await fetch(url);

    // Important: force error on 404 or other bad status
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    await streamPipeline(res.body, fs.createWriteStream(dst));
  }


  async function downloadWithFallback(urls: string[], dst: string) {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];

      logger(chalk.gray(`⇣  [${i + 1}/${urls.length}] ${url}`));

      try {
        await download(url, dst);
        logger(chalk.green(`Download succeeded (mirror ${i + 1})`));
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger(chalk.yellow(`Download failed: ${msg}`));

        // automatically delete the half-downloaded file, if any
        try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch { /* ignore */ }
        // loop continues to the next mirror
      }
    }

    throw new Error(`All mirrors failed for ${path.basename(dst)}`);
  }


  function findFile(dir: string, name: string): string | undefined {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return full;
      if (e.isDirectory()) {
        const hit = findFile(full, name);
        if (hit) return hit;
      }
    } return;
  }

  async function extractZip(a: string, d: string) { new AdmZip(a).extractAllTo(d, true); }

  async function extract7z(a: string, d: string) {
    await new Promise<void>((ok, bad) => {
      const p = spawn(path7za, ["x", a, `-o${d}`, "-y"]);
      p.stdout.on("data", d => logger(d.toString()));
      p.stderr.on("data", d => logger(d.toString()));
      p.on("close", c => c === 0 ? ok() : bad());
    });
  }

  async function run(cmd: string, args: string[], cwd?: string) {
    await new Promise<void>((ok, bad) => {
      const p = spawn(cmd, args, { cwd });
      p.stdout.on("data", d => logger(d.toString()));
      p.stderr.on("data", d => logger(d.toString()));
      p.on("close", c => c === 0 ? ok() : bad(new Error(`${cmd} ${c}`)));
    });
  }

  let zstdExe: string | undefined;

  /* quick check ---------------------------------------------------*/
  if (onlyCheck) {
    logLineCentered("Check Installed Packages");

    const verInfo: Record<string, { exe: string; args: string[]; re: RegExp }> = {
      python_portable: { exe: "python\\python\\python.exe", args: ["--version"], re: /Python (\S+)/ },
      cmake: { exe: "cmake\\bin\\cmake.exe", args: ["--version"], re: /version (\S+)/ },
      ninja: { exe: "ninja\\ninja.exe", args: ["--version"], re: /^(\S+)/ },
      git: { exe: "git\\bin\\git.exe", args: ["--version"], re: /git version ([^\s]+)/ },
      gperf: { exe: "gperf\\bin\\gperf.exe", args: ["--version"], re: /GNU gperf (\S+)/ },
      dtc: { exe: "dtc\\usr\\bin\\dtc.exe", args: ["--version"], re: /Version: DTC (\S+)/ },
      wget: { exe: "wget\\wget.exe", args: ["--version"], re: /GNU Wget (\S+)/ },
      seven_z_portable: { exe: "7zip\\7z.exe", args: [], re: /7-Zip.*?(\d+\.\d+)/ },
      zstd: { exe: "zstd\\zstd.exe", args: ["--version"], re: /v?(\d+\.\d+\.\d+)/ }
    };

    const results: string[] = [];
    let missing = 0;

    for (const tool of TOOL_ORDER) {
      const info = verInfo[tool];
      if (!info) continue;

      const exePath = path.join(TOOLS, info.exe);
      if (!fs.existsSync(exePath)) {
        results.push(`${tool.padEnd(15)} ${chalk.red("[missing]")}`);
        missing++;
        continue;
      }

      try {
        const out = execFileSync(exePath, info.args, { encoding: "utf8" });
        const match = info.re.exec(out.trim());
        const version = match ? match[1] : "?";
        results.push(`${tool.padEnd(15)} ${chalk.green(`[${version}]`)}`);
      } catch {
        results.push(`${tool.padEnd(15)} ${chalk.red("[error]")}`);
        missing++;
      }
    }

    results.forEach(line => logger(line));
    if (missing > 0) {
      logger(chalk.red(`\n${missing} tool(s) are missing or failed.`));
      return;
    } else {
      logger(chalk.green("\nAll specified packages are installed."));
      return;
    }
  }

  /* Python Zephyr requirements -----------------------------------------*/
  const reqFiles = [
    "requirements.txt",
    "requirements-run-test.txt",
    "requirements-extras.txt",
    "requirements-compliance.txt",
    "requirements-build-test.txt",
    "requirements-base.txt"
  ];

  /* folders -------------------------------------------------------*/
  fs.mkdirSync(TOOLS, { recursive: true });
  fs.mkdirSync(DL, { recursive: true });

  if (reinstallVenv) {
    logLine("Re-installing Python virtual-environment");

    // locate python.exe that the first full install already placed
    const pyExe = path.join(
      TOOLS, "python", "python", "python.exe"
    );
    if (!fs.existsSync(pyExe))
      throw new Error("Python tools not found - run full install once first.");

    // remove the old venv if present
    if (fs.existsSync(VENV))
      fs.rmSync(VENV, { recursive: true, force: true });

    // create new venv
    await run(pyExe, ["-m", "venv", VENV]);

    const pip = path.join(VENV, "Scripts", "pip.exe");

    // core packages
    await run(pip, ["install", "-q",
      "setuptools", "wheel", "west", "pyelftools"
    ]);

    const baseUrl = "https://raw.githubusercontent.com/zephyrproject-rtos/zephyr/main/scripts";
    const reqDir = path.join(ROOT, "tmp", "requirements");
    fs.mkdirSync(reqDir, { recursive: true });

    for (const f of reqFiles)
      await download(`${baseUrl}/${f}`, path.join(reqDir, f));

    await run(pip, ["install", "-q", "windows-curses", "anytree"]);
    await run(pip, ["install", "-q", "-r",
      path.join(reqDir, "requirements.txt")]);
    await run(pip, ["install", "-q", "puncover"]);

    log(chalk.green("\nVENV rebuilt - no other host tools touched"));
    return;
  }

  /* install loop --------------------------------------------------*/
  for (const name of TOOL_ORDER) {
    const info = windowsTools.find(t => t.tool === name)!;
    const entry = info.os.windows;
    const sourcesArr = Array.isArray(entry.source) ? entry.source : [entry.source];
    const dstFile = path.join(DL, path.basename(sourcesArr[0]));
    const { sha256: hash } = info.os.windows;
    const dstDir = path.join(TOOLS, name === "python_portable" ? "python" : name);

    logLine(`Installing ${name}`);
    await downloadWithFallback(sourcesArr, dstFile);
    if (hash && sha256(dstFile).toUpperCase() !== hash.toUpperCase())
      throw Error(`${name}: SHA256 mismatch`);

    fs.mkdirSync(dstDir, { recursive: true });

    if (dstFile.endsWith(".zip")) {
      await extractZip(dstFile, dstDir);
    } else if (dstFile.endsWith(".7z")) {
      await extract7z(dstFile, dstDir);
    } else if (dstFile.match(/\.7z\.exe$/i) || dstFile.match(/PortableGit.*\.exe$/i) || dstFile.match(/Winpython.*\.exe$/i)) {
      await extract7z(dstFile, dstDir);
    } else if (dstFile.match(/7-Zip-\d+\.\d+\.exe$/i)) {
      await run(dstFile, [`-o${dstDir}`, "-y"]);
    } else if (dstFile.match(/\.pkg\.tar\.zst$/i) || dstFile.match(/\.tar\.zst$/i)) {
      if (!zstdExe) throw Error("zstd.exe not ready yet for .zst file");
      const tar = dstFile.replace(/\.zst$/i, "");
      await run(zstdExe, ["-d", "-q", dstFile, "-o", tar]);
      await extract7z(tar, dstDir);
      fs.unlinkSync(tar);
    } else if (dstFile.endsWith(".exe")) {
      fs.copyFileSync(dstFile, path.join(dstDir, path.basename(dstFile)));
    } else {
      throw Error(`Unknown archive type: ${dstFile}`);
    }

    /* post-layout tweaks -------------------------------------------*/
    if (name === "seven_z_portable") {
      const exe = findFile(dstDir, "7z.exe");
      if (!exe) throw Error("7z.exe not found in seven_z_portable");
      fs.mkdirSync(path.join(TOOLS, "7zip"), { recursive: true });
      fs.copyFileSync(exe, path.join(TOOLS, "7zip", "7z.exe"));
    }

    if (name === "cmake") {
      const entries = fs.readdirSync(dstDir);
      if (entries.length === 1 && fs.statSync(path.join(dstDir, entries[0])).isDirectory()) {
        const inner = path.join(dstDir, entries[0]);
        // move every file / folder up one level
        for (const item of fs.readdirSync(inner)) {
          fs.renameSync(path.join(inner, item), path.join(dstDir, item));
        }
        fs.rmdirSync(inner);
      }
    }

    if (name === "zstd") {
      const exe = findFile(dstDir, "zstd.exe");
      if (exe) {
        fs.copyFileSync(exe, path.join(dstDir, "zstd.exe"));
      }
      zstdExe = exe;
    }

    if (name === "python_portable") {
      let pythonRoot: string | undefined;

      const wpy = fs.readdirSync(dstDir)
        .find(d => d.toLowerCase().startsWith("wpy64-"));

      if (wpy &&
        fs.existsSync(path.join(dstDir, wpy, "python", "python.exe"))) {
        pythonRoot = path.join(dstDir, wpy, "python");
      }

      if (!pythonRoot &&
        fs.existsSync(path.join(dstDir, "python", "python.exe"))) {
        pythonRoot = path.join(dstDir, "python");
      }

      if (!pythonRoot) {
        throw new Error("Cannot locate python.exe in WinPython package");
      }

      const finalDir = path.join(dstDir, "python");

      if (!fs.existsSync(finalDir)) {
        fs.mkdirSync(path.dirname(finalDir), { recursive: true });
        fs.renameSync(pythonRoot, finalDir);
      }

      if (wpy) {
        try { fs.rmSync(path.join(dstDir, wpy), { recursive: true, force: true }); }
        catch {/* ignore */ }
      }
    }
  }

  try {
    const msys2Bin = path.join(TOOLS, "msys2_runtime", "usr", "bin");
    const libyamlBin = path.join(TOOLS, "libyaml", "usr", "bin");
    const dtcBin = path.join(TOOLS, "dtc", "usr", "bin");

    fs.copyFileSync(path.join(msys2Bin, "msys-2.0.dll"), path.join(dtcBin, "msys-2.0.dll"));
    fs.copyFileSync(path.join(libyamlBin, "msys-yaml-0-2.dll"), path.join(dtcBin, "msys-yaml-0-2.dll"));

    logger(chalk.green("dtc DLL dependencies copied successfully"));
  } catch (e) {
    logger(chalk.red("Failed to copy DLLs for dtc — msys2 or libyaml missing?"));
    throw e;
  }

  /* venv ----------------------------------------------------------*/
  if (reinstallVenv && fs.existsSync(VENV))
    fs.rmSync(VENV, { recursive: true, force: true });

  if (!fs.existsSync(path.join(VENV, "Scripts", "activate.bat"))) {
    await run(
      path.join(TOOLS, "python", "python", "python.exe"),
      ["-m", "venv", VENV]
    );
    await run(
      path.join(VENV, "Scripts", "pip.exe"),
      ["install", "-q", "setuptools", "wheel", "west", "pyelftools"]
    );
  }

  const baseUrl = "https://raw.githubusercontent.com/zephyrproject-rtos/zephyr/main/scripts";
  const reqDir = path.join(ROOT, "tmp", "requirements");
  fs.mkdirSync(reqDir, { recursive: true });

  for (const f of reqFiles) {
    const url = `${baseUrl}/${f}`;
    const dst = path.join(reqDir, f);
    await download(url, dst);
  }

  // Install the main requirements file (which pulls others)
  const pip = path.join(VENV, "Scripts", "pip.exe");
  await run(pip, ["install", "-q", "windows-curses", "anytree"]);
  await run(pip, ["install", "-q", "-r", path.join(reqDir, "requirements.txt")]);
  await run (pip, ["install", "-q", "puncover"]);

  /* env scripts ---------------------------------------------------*/
  const bat = `
  @echo off
  @set "PATH=%~dp0tools\\cmake\\bin;%~dp0tools\\dtc\\usr\\bin;%~dp0tools\\gperf\\bin;%~dp0tools\\ninja;%~dp0tools\\wget;%~dp0tools\\git\\bin;%~dp0tools\\7zip;%~dp0tools\\python\\python;%PATH%"
  @call "%~dp0.venv\\Scripts\\activate.bat"
  `.trim();

  fs.writeFileSync(path.join(ROOT, "env.bat"), bat, "ascii");

  const ps1 = `
$env:PATH="$PSScriptRoot\\tools\\cmake\\bin;$PSScriptRoot\\tools\\dtc\\usr\\bin;$PSScriptRoot\\tools\\gperf\\bin;$PSScriptRoot\\tools\\ninja;$PSScriptRoot\\tools\\wget;$PSScriptRoot\\tools\\git\\bin;$PSScriptRoot\\tools\\7zip;$PSScriptRoot\\tools\\python\\python;$env:PATH"
. "$PSScriptRoot\\.venv\\Scripts\\Activate.ps1"
`.trim();
  fs.writeFileSync(path.join(ROOT, "env.ps1"), ps1, "ascii");

  const sh = `#!/usr/bin/env bash
# Resolve the directory this script lives in
if [ -n "\${BASH_SOURCE-}" ]; then _src="\${BASH_SOURCE[0]}";
elif [ -n "\${ZSH_VERSION-}" ]; then _src="\${(%):-%N}";
else _src="\$0"; fi
base_dir="$(cd -- "\$(dirname -- "\$_src")" && pwd -P)"
tools_dir="\$base_dir/tools"

cmake_path="\$tools_dir/cmake/bin"
dtc_path="\$tools_dir/dtc/usr/bin"
gperf_path="\$tools_dir/gperf/bin"
ninja_path="\$tools_dir/ninja"
wget_path="\$tools_dir/wget"
git_path="\$tools_dir/git/bin"
python_path="\$tools_dir/python/python"
seven_z_path="\$tools_dir/7zip"

[[ -d "\$python_path" ]] || python_path=""
[[ -d "\$seven_z_path" ]] || seven_z_path=""

export PATH="\$python_path:\$git_path:\$wget_path:\$ninja_path:\$gperf_path:\$dtc_path:\$cmake_path:\$seven_z_path:\$PATH"

default_venv_activate_path="\$base_dir/.venv/Scripts/activate"
venv_activate_path="\${PYTHON_VENV_ACTIVATE_PATH:-\$default_venv_activate_path}"

if [[ -f "\$venv_activate_path" ]]; then
  # shellcheck disable=SC1090
  . "\$venv_activate_path"
  echo "Activated virtual environment at \$venv_activate_path"
else
  echo "Error: Virtual environment activation script not found at \$venv_activate_path."
fi
`.trim() + "\n";

  const envShPath = path.join(ROOT, "env.sh");
  fs.writeFileSync(envShPath, sh, { encoding: "ascii", mode: 0o755 });

  /* version/hash file */
  const scriptMd5 = md5(__filename);
  const toolsYmlMd5 = md5(yamlPath);
  const versionTxt = `Script Version: ${VERSION}
Script MD5: ${scriptMd5}
tools.yml MD5: ${toolsYmlMd5}
`;
  fs.writeFileSync(path.join(ROOT, "zinstaller_version"), versionTxt, "ascii");

  // remove everything under ROOT/tmp
  const tmpDir = path.join(ROOT, "tmp");
  if (fs.existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
    logger(chalk.gray(`Cleaned up temporary directory: ${tmpDir}`));
  }

  logger(chalk.green("\nHost tools ready"));
}