import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import fetch from 'node-fetch';
import * as crypto from 'crypto';
import YAML from 'yaml';
import { spawnSync } from 'child_process';
import AdmZip from 'adm-zip';
import SevenBin from '7zip-bin';

const BASE_DIR = path.join(os.homedir(), '.zinstaller');
const TMP_DIR = path.join(BASE_DIR, 'tmp');
const DL_DIR = path.join(TMP_DIR, 'downloads');
const TOOLS_DIR = path.join(BASE_DIR, 'tools');

const YAML_PATH = path.join(__dirname, '..', 'resources', 'debug-tools.yml');
const out = vscode.window.createOutputChannel('Debug Tools Installer');

function ensureDir(dir: string) {
    return fs.promises.mkdir(dir, { recursive: true }).catch(() => { });
}

function banner(text: string) {
    const bar = '-'.repeat(40);
    out.appendLine(bar);
    out.appendLine(text.padStart(Math.floor((40 + text.length) / 2)));
    out.appendLine(bar);
}

function sha256(file: string): Promise<string> {
    return new Promise((ok, err) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(file)
            .on('data', d => h.update(d))
            .on('end', () => ok(h.digest('hex')))
            .on('error', err);
    });
}

async function download(url: string, dst: string) {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await ensureDir(path.dirname(dst));
    await new Promise((ok, err) =>
        res.body!.pipe(fs.createWriteStream(dst)).once('finish', ok).once('error', err)
    );
}

async function downloadChecked(url: string, hash: string) {
    const dst = path.join(DL_DIR, path.basename(url));
    if (!fs.existsSync(dst)) await download(url, dst);
    if ((await sha256(dst)).toLowerCase() !== hash.toLowerCase())
        throw new Error(`hash mismatch: ${path.basename(dst)}`);
    return dst;
}

function isArchive(f: string) {
    return /\.(zip|7z|rar)$/i.test(f);
}

function extract(src: string, dst: string) {
    if (src.endsWith('.zip')) {
        new AdmZip(src).extractAllTo(dst, true);
    } else {
        spawnSync(SevenBin.path7za, ['x', src, `-o${dst}`, '-y'], { stdio: 'ignore' });
    }
}

interface Entry { tool: string; os: Record<string, { source: string; sha256: string }> }

async function loadManifest() {
    const data = YAML.parse(await fs.promises.readFile(YAML_PATH, 'utf8')) as Entry[];
    const m: Record<string, { url: string; sha256: string }> = {};
    for (const e of data) {
        const win = e.os?.windows;
        if (win) m[e.tool] = { url: win.source, sha256: win.sha256 };
    }
    return m;
}

function silentInstall(exe: string) {
    spawnSync(exe, ['/S'], { stdio: 'inherit' });
}

async function installTool(name: string, manifest: Record<string, { url: string; sha256: string }>) {
    const e = manifest[name];
    if (!e) throw new Error(`unknown tool: ${name}`);
    const file = await downloadChecked(e.url, e.sha256);
    const dst = path.join(TOOLS_DIR, name);
    await ensureDir(dst);
    if (isArchive(file)) extract(file, dst);
    else silentInstall(file);
}

export async function installDebugTools(tools: string[]) {
    banner('Zephyr installer');
    for (const d of [BASE_DIR, TMP_DIR, DL_DIR, TOOLS_DIR]) await ensureDir(d);
    const manifest = await loadManifest();
    for (const t of tools) {
        out.appendLine(`install ${t}`);
        await installTool(t, manifest);
    }
    await fs.promises.rm(TMP_DIR, { recursive: true, force: true });
    out.appendLine('done');
}
