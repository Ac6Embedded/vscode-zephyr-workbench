
import * as vscode from "vscode";
import path from "path";
import { execCommand, extract, getFirstDirectoryName7z } from "./installUtils";
import { ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY, ZEPHYR_WORKBENCH_LIST_IARS_SETTING_KEY } from "../constants";
import { getGitTags } from "./execUtils";

export const sdkRepoURL = "https://github.com/zephyrproject-rtos/sdk-ng/";

export const sdkType = [ 'full', 'minimal' ];
export const sdkOSes = [ 'linux', 'windows', 'macos' ];
export const sdkArch = [ 'aarch64', 'x86_64'];
export const sdkExt = [ 'tar.xz' , '7z'];

export const minSdkURL = "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v${version}/zephyr-sdk-${version}_${os}-${arch}_minimal.${ext}";
export const fullSdkURL = "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v${version}/zephyr-sdk-${version}_${os}-${arch}.${ext}";
export const toolsSdkURL = "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v${version}/toolchain_${os}-${arch}_${toolchain}.${ext}";

type SdkHostTarget = {
	os: 'linux' | 'windows' | 'macos';
	arch: 'x86_64' | 'aarch64';
	ext: 'tar.xz' | '7z';
};

export function getSdkHostTarget(): SdkHostTarget | undefined {
	let os: SdkHostTarget['os'] | undefined;
	let arch: SdkHostTarget['arch'] | undefined;
	let ext: SdkHostTarget['ext'] | undefined;
	
	switch(process.platform) {
		case 'linux': {
			os = 'linux';
			ext = 'tar.xz';
			break;
		}
		case 'win32': {
			os = 'windows';
			ext = '7z';
			break;
		}
		case 'darwin': {
			os = 'macos';
			ext = 'tar.xz';
			break;
		}	
		default:
			break;
	}

	switch(process.arch) {
		case 'x64': {
			arch = 'x86_64';
			break;
		}
		case 'arm64': {
			arch = 'aarch64';
			break;
		}
		default:
			break;
	}

	if (os && arch && ext) {
		return { os, arch, ext };
	}
	return undefined;
}

export async function getSdkVersion(): Promise<any[]> {
	try {
		const tags = await getGitTags(sdkRepoURL);
		let versions = [];
		if(tags && tags.length > 0) {
			for(let tag of tags) {
				// do not keep -alpha, -beta, -rc versions
				if(!tag.includes('-')) {
					versions.push(tag);
				}
			}
		}
		return versions;
	} catch (error) {
		return [];
	}
}

export function generateSdkUrls(type: string, version: string, toolchains: string[]): string[] {
	let urls: string[] = [];
	const host = getSdkHostTarget();

	if(host) {
		if(type === 'full') {
			const fullUrl = `https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v${version}/zephyr-sdk-${version}_${host.os}-${host.arch}.${host.ext}`;
			urls.push(fullUrl);
		} else if(type === 'minimal') {
			const minUrl = `https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v${version}/zephyr-sdk-${version}_${host.os}-${host.arch}_minimal.${host.ext}`;
			urls.push(minUrl);

			for(const tArch of toolchains) {
				const toolchain = mapToolchainIdToPackage(tArch);
				if (!toolchain) { continue; }
				const toolUrl = `https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v${version}/toolchain_${host.os}-${host.arch}_${toolchain}.${host.ext}`;
				urls.push(toolUrl);
			}
		} 
	}
	
	return urls;
}

export async function getMinimalToolchainsForVersion(version: string): Promise<string[]> {
	const host = getSdkHostTarget();
	if (!host) {
		throw new Error('Unsupported host platform for Zephyr SDK downloads.');
	}

	const tag = version?.startsWith('v') ? version : `v${version}`;
	const response = await fetch(`https://github.com/zephyrproject-rtos/sdk-ng/releases/tag/${tag}`, {
		headers: { 'User-Agent': 'zephyr-workbench' }
	});
	if (!response.ok) {
		throw new Error(`Failed to fetch release page (${response.status})`);
	}
	const html = await response.text();
	const tableMatch = html.split('<h3>Toolchains</h3>')[1]?.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
	if (!tableMatch) {
		throw new Error('Could not find toolchain table on release page.');
	}
	const rows = Array.from(tableMatch[1].matchAll(/<tr>([\s\S]*?)<\/tr>/gi));
	// Skip header row
	const hostColIdx = host.os === 'linux' ? 1 : host.os === 'macos' ? 2 : 3;
	const toolchains: string[] = [];
	for (let i = 1; i < rows.length; i++) {
		const cells = Array.from(rows[i][1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map(m => m[1]);
		if (cells.length <= hostColIdx) {
			continue;
		}
		const targetName = stripHtml(cells[0]);
		const cellHtml = cells[hostColIdx];
		if (hasMatchingAsset(cellHtml, host)) {
			toolchains.push(targetName);
		}
	}
	if (toolchains.length === 0) {
		throw new Error('No toolchains found for this platform on the selected release.');
	}
	return toolchains.map(friendlyToolchainId);
}

function hasMatchingAsset(cellHtml: string, host: SdkHostTarget): boolean {
	const links = Array.from(cellHtml.matchAll(/href="([^"]+)"/gi)).map(m => m[1]);
	return links.some(link => link.includes(`_${host.os}-${host.arch}_`));
}

function stripHtml(content: string): string {
	return content.replace(/<[^>]*>/g, '').trim();
}

/**
 * Convert a toolchain identifier from the release table into a user-friendly id.
 * Examples:
 *   "aarch64-zephyr-elf" -> "aarch64"
 *   "arm-zephyr-eabi" -> "arm"
 *   "xtensa-espressif_esp32s3_zephyr-elf" -> "xtensa-espressif_esp32s3"
 */
export function friendlyToolchainId(name: string): string {
	const match = name.match(/^(.*?)[-_]zephyr-(?:elf|eabi)$/);
	return match ? match[1] : name;
}

/**
 * Map a friendly toolchain id (e.g. "arm", "aarch64", "xtensa-espressif_esp32s3")
 * back to the package name used in download URLs.
 */
export function mapToolchainIdToPackage(id: string): string {
	if (!id) { return id; }
	if (id.includes('zephyr-elf') || id.includes('zephyr-eabi')) {
		return id;
	}

	switch (id) {
		case 'arm':
			return 'arm-zephyr-eabi';
		case 'aarch64':
			return 'aarch64-zephyr-elf';
		case 'riscv':
		case 'riscv64':
			return 'riscv64-zephyr-elf';
		default:
			break;
	}

	if (id.startsWith('xtensa-')) {
		return `${id}_zephyr-elf`;
	}

	return `${id}-zephyr-elf`;
}

export async function registerZephyrSDK(sdkPath: string) {
	let listSDKs: string[] | undefined = await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY);
	if(listSDKs) {
		for(let fSdkPath of listSDKs) {
			if(fSdkPath === sdkPath) {
				throw new Error(`This SDK [${sdkPath}] is already registered.`);
			}
		}
		listSDKs.push(sdkPath);
		await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).update(ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY, listSDKs, vscode.ConfigurationTarget.Global);
	} else {
		throw new Error(`Cannot register SDK: setting value corrupted, please edit the settings.json `);
	}
}

/**
 * Append a {zephyrSdkPath, iarPath, token} object to
 *    zephyr‑workbench.listIARs  (machine scope, array)
 */
export async function registerIARToolchain(iar: {
	zephyrSdkPath: string;
	iarPath: string;
	token: string;
  }) {
	const cfg = vscode.workspace.getConfiguration(
	  ZEPHYR_WORKBENCH_SETTING_SECTION_KEY,
	);
  
	/* read current list (or []) */
	const list: any[] =
	  cfg.get(ZEPHYR_WORKBENCH_LIST_IARS_SETTING_KEY) ?? [];
  
	/* ensure we don’t store the same IAR twice */
	if (list.find((e) => e.iarPath === iar.iarPath)) {
	  throw new Error(`This IAR toolchain [${iar.iarPath}] is already registered.`);
	}
  
	list.push(iar);
  
	await cfg.update(
	  ZEPHYR_WORKBENCH_LIST_IARS_SETTING_KEY,
	  list,
	  vscode.ConfigurationTarget.Global,
	);
  }

export async function unregisterZephyrSDK(sdkPath: string) {
	let listSDKs: string[] | undefined = await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).get(ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY);
	if(listSDKs) {
		for(let fSdkPath of listSDKs) {
			if(fSdkPath === sdkPath) {
				let index = listSDKs.indexOf(sdkPath, 0);
				listSDKs.splice(index, 1);
				await vscode.workspace.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY).update(ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY, listSDKs, vscode.ConfigurationTarget.Global);
				return;
			}
		}
		throw new Error(`This SDK [${sdkPath}] is not found.`);
	} else {
		throw new Error(`Cannot unregister SDK: setting value corrupted, please edit the settings.json `);
	}
}

export async function unregisterIARToolchain(iarPath: string) {
	let listIARs: any[] | undefined =
	  vscode.workspace
		.getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
		.get(ZEPHYR_WORKBENCH_LIST_IARS_SETTING_KEY);
  
	if (listIARs) {
	  const idx = listIARs.findIndex(i => i.iarPath === iarPath);
	  if (idx !== -1) {
		listIARs.splice(idx, 1);
		await vscode.workspace
		  .getConfiguration(ZEPHYR_WORKBENCH_SETTING_SECTION_KEY)
		  .update(
			ZEPHYR_WORKBENCH_LIST_IARS_SETTING_KEY,
			listIARs,
			vscode.ConfigurationTarget.Global
		  );
		return;
	  }
	  throw new Error(`This IAR toolchain [${iarPath}] is not found.`);
	} else {
	  throw new Error(
		"Cannot unregister IAR Toolchain: setting value corrupted, please edit settings.json"
	  );
	}
  }

export async function extractSDKTar(filePath: string, destPath: string, progress: vscode.Progress<{
  message?: string | undefined;
  increment?: number | undefined;
}>, token: vscode.CancellationToken): Promise<string> {
  try {
    await extract(filePath, destPath, progress, token);

    const fileNameCmd = `tar -tf "${filePath}" | head -1`;
    let fileName = await execCommand(fileNameCmd);
    fileName = path.dirname(fileName);
    return path.join(destPath, fileName);
  } catch (error) {
    throw new Error('Cannot extract archive');
  }
}

export async function extractSDK7z(filePath: string, destPath: string, progress: vscode.Progress<{
  message?: string | undefined;
  increment?: number | undefined;
}>, token: vscode.CancellationToken): Promise<string> {
  await extract(filePath, destPath, progress, token);

  const rootFolder = await getFirstDirectoryName7z(filePath);
  return path.join(destPath, rootFolder);
}

/**
 * Extract the SDK archive and return the folder name in first level
 * (SDK archive name is not equal to the SDK root folder)
 * @param filePath 
 * @param destPath 
 * @param progress 
 * @param token 
 * @returns The root folder name
 */
export async function extractSDK(filePath: string, destPath: string, progress: vscode.Progress<{
  message?: string | undefined;
  increment?: number | undefined;
}>, token: vscode.CancellationToken): Promise<string> {
  if(filePath.includes(".7z")) {
    return await extractSDK7z(filePath, destPath, progress, token);
  } else if(filePath.includes(".tar")) {
    return await extractSDKTar(filePath, destPath, progress, token);
  } else {
    return Promise.reject(new Error("Unsupported file format"));
  }
}
