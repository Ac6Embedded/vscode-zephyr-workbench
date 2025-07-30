// src/installDebugTools.ts
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import fetch from "node-fetch";
import * as crypto from "crypto";
import YAML from "yaml";
import { spawnSync, SpawnSyncOptions } from "child_process";
import AdmZip from "adm-zip";
import SevenBin from "7zip-bin";
import chalk from "chalk";
import sudo from "sudo-prompt";


const YAML_PATH = path.join(__dirname, "..", "scripts", "hosttools", "debug-tools.yml");
const out = vscode.window.createOutputChannel("Zinstaller");

function showChannelOnce() {
    if (!showChannelOnce.done) { out.show(); showChannelOnce.done = true; }
}
showChannelOnce.done = false as boolean;

function logLine(msg: string) {
    showChannelOnce();
    out.appendLine(chalk.cyan("\n" + "-".repeat(40) + "\n" + msg));
}
function logLineCentered(msg: string) {
    showChannelOnce();
    const w = 40, pad = Math.floor((w - msg.length) / 2);
    out.appendLine("\n" + "-".repeat(w));
    out.appendLine(" ".repeat(Math.max(pad, 0)) + msg);
    out.appendLine("-".repeat(w));
}
function warn(msg: string) { showChannelOnce(); out.appendLine(chalk.yellow("WARN: " + msg)); }
function error(msg: string) { showChannelOnce(); out.appendLine(chalk.red("ERROR: " + msg)); }
function info(msg: string) { showChannelOnce(); out.appendLine(msg); }

async function ensureDir(dir: string) {
    await fs.promises.mkdir(dir, { recursive: true }).catch(() => { });
}
function sha256(f: string): Promise<string> {
    return new Promise((ok, bad) => {
        const h = crypto.createHash("sha256");
        fs.createReadStream(f)
            .on("data", d => h.update(d))
            .on("end", () => ok(h.digest("hex")))
            .on("error", bad);
    });
}

async function download(url: string, dst: string) {
    info(chalk.gray(`⇣  ${url}`));
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await ensureDir(path.dirname(dst));
    await new Promise((ok, bad) =>
        res.body!.pipe(fs.createWriteStream(dst)).once("finish", ok).once("error", bad)
    );
}

async function downloadChecked(
    url: string,
    hash: string,
    dlDir: string
) {
    const dst = path.join(dlDir, path.basename(url));
    if (!fs.existsSync(dst)) await download(url, dst);
    const actual = (await sha256(dst)).toLowerCase();
    if (actual !== hash.toLowerCase())
        throw new Error(`hash mismatch: ${path.basename(dst)}`);
    info(chalk.green(`DL: ${path.basename(dst)} downloaded successfully`));
    return dst;
}


function isArchive(f: string) { return /\.(zip|7z|rar)$/i.test(f); }

function extract(src: string, dst: string) {
    if (src.endsWith(".zip")) new AdmZip(src).extractAllTo(dst, true);
    else spawnSync(SevenBin.path7za, ["x", src, `-o${dst}`, "-y"], { stdio: "ignore" });
    info(chalk.green(`Extraction successful: ${path.basename(src)}`));
}

interface Entry {
    tool: string;
    os: Record<string, { source: string | string[]; sha256: string }>;
}

/* run an installer */
function runExe(exe: string, args: string[] = [], interactive = false) {
    const opts: SpawnSyncOptions = interactive
        ? { stdio: "inherit", shell: true, windowsHide: false }
        : { stdio: "ignore", windowsHide: true };

    const cmd = interactive ? `"${exe}"` : exe;   // quote only in shell mode
    const { status, error: errObj } = spawnSync(cmd, args, opts);

    if (status === null) {
        const msg = errObj?.message ?? "process failed to launch";
        throw new Error(`${path.basename(exe)} - ${msg}`);
    }
    if (status !== 0) {
        throw new Error(`${path.basename(exe)} exited with ${status}`);
    }
}


function collapseDoubleFolder(dst: string, tool: string) {
    const one = fs.readdirSync(dst);
    if (one.length === 1 && one[0].toLowerCase() === tool.toLowerCase()) {
        const inner = path.join(dst, one[0]);
        for (const f of fs.readdirSync(inner))
            fs.renameSync(path.join(inner, f), path.join(dst, f));
        fs.rmdirSync(inner);
    }
}

function runElevated(cmd: string, title: string): Promise<void> {
    return new Promise((resolve, reject) => {
        sudo.exec(cmd, { name: title }, (err, stdout, stderr) => {
            if (err) {
                reject(err);
                return;
            }
            if (stderr) {
                warn(String(stderr).trim());
            }
            if (stdout) {
                info(String(stdout).trim());
            }
            resolve();
        });
    });
}


async function installTool(
    name: string,
    manifest: Record<string, { url: string; sha256: string }>,
    dlDir: string,
    toolsDir: string
) {
    const ent = manifest[name];
    if (!ent) { error(`Unknown tool: ${name}`); return; }

    const src = await downloadChecked(ent.url, ent.sha256, dlDir);
    const dstDir = path.join(toolsDir, name);
    await ensureDir(dstDir);

    if (isArchive(src)) {
        extract(src, dstDir);
        collapseDoubleFolder(dstDir, name);

        /* after extraction, handle special cases -------------------------- */
        const files = fs.readdirSync(dstDir, { withFileTypes: true });

        const cube = files.find(f =>
            f.isFile() && f.name.toLowerCase().startsWith("setupstm32cubeprogrammer")
        );
        if (cube) runExe(path.join(dstDir, cube.name), [], true);
        if (name === "cp210x-win-driver") {
            const infPaths: string[] = [];
            function walk(dir: string) {
                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                    const full = path.join(dir, e.name);
                    if (e.isDirectory()) walk(full);
                    else if (e.isFile() && e.name.toLowerCase() === "silabser.inf")
                        infPaths.push(full);
                }
            }
            walk(dstDir);

            if (infPaths.length === 0) {
                warn("silabser.inf not found in CP210x package");
            } else {
                for (const inf of infPaths) {
                    info(`Installing CP210x driver from ${path.relative(dstDir, inf)} (UAC)…`);
                    try {
                        await runElevated(
                            `pnputil /add-driver "${inf}" /install`,
                            "CP210x Driver"
                        );
                        info("Driver installed");
                    } catch (e: any) {
                        warn(`Driver install failed: ${e.message}`);
                    }
                }
            }
        }
        return; 
    }

    /* non-archive EXE ---------------------------------------------------- */
    const exe = path.basename(src).toLowerCase();
    try { runExe(src, ["/S"]); }
    catch { runExe(src, [], true); }   // fallback to interactive wizard

    fs.copyFileSync(src, path.join(dstDir, exe));
}




async function loadManifest() {
    const doc = YAML.parse(await fs.promises.readFile(YAML_PATH, "utf8"));

    const list = (doc.debug_tools ?? []) as Entry[];

    const m: Record<string, { url: string; sha256: string }> = {};
    for (const e of list) {
        const win = e.os?.windows;
        if (win) {
            const url = Array.isArray(win.source) ? win.source[0] : win.source;
            m[e.tool] = { url, sha256: win.sha256 };
        }
    }
    return m;
}


export async function installDebugTools(
    tools: string[],
    installDir: string = os.homedir()
) {
    const BASE_DIR = path.join(installDir, ".zinstaller");
    const TMP_DIR = path.join(BASE_DIR, "tmp");
    const DL_DIR = path.join(TMP_DIR, "downloads");
    const TOOLS_DIR = path.join(BASE_DIR, "tools");

    await Promise.all([BASE_DIR, TMP_DIR, DL_DIR, TOOLS_DIR].map(ensureDir));
    const manifest = await loadManifest();
    logLineCentered("Install Debug Tools");

    for (const t of tools) {
        logLine(`Installing ${t}`);
        try {
            await installTool(t, manifest, DL_DIR, TOOLS_DIR);
        } catch (e: any) {
            error(String(e));
            throw e;
        }
    }

    await fs.promises.rm(TMP_DIR, { recursive: true, force: true });
    info(chalk.green("done"));
}
