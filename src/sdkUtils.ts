
import * as vscode from "vscode";
import path from "path";
import { execCommand, extract, getFirstDirectoryName7z } from "./installUtils";
import { ZEPHYR_WORKBENCH_LIST_SDKS_SETTING_KEY, ZEPHYR_WORKBENCH_SETTING_SECTION_KEY } from "./constants";
import { getGitTags } from "./execUtils";
import { url } from "inspector";

export const sdkRepoURL = "https://github.com/zephyrproject-rtos/sdk-ng/";

export const listToolchainArch = [ 'aarch64', 'arm', 'arc', 'arc64', 'microblazeel', 'mips',  'nios2', 
	'riscv64', 'sparc', 'x86_64', 'xtensa-dc233c', 'xtensa-espressif_esp32', 'xtensa-espressif_esp32s2',
	'xtensa-espressif_esp32s3', 'xtensa-intel_ace15_mtpm', 'xtensa-intel_tgl_adsp', 'xtensa-mtk_mt8195_adsp',
	'xtensa-nxp_imx_adsp', 'xtensa-nxp_imx8m_adsp', 'xtensa-nxp_imx8ulp_adsp', 'xtensa-nxp_rt500_adsp',
	'xtensa-nxp_rt600_adsp', 'xtensa-sample_controller'
];

export const sdkType = [ 'full', 'minimal' ];
export const sdkOSes = [ 'linux', 'windows', 'macos' ];
export const sdkArch = [ 'aarch64', 'x86_64'];
export const sdkExt = [ 'tar.xz' , '7z'];

export const minSdkURL = "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v${version}/zephyr-sdk-${version}_${os}-${arch}_minimal.${ext}";
export const fullSdkURL = "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v${version}/zephyr-sdk-${version}_${os}-${arch}.${ext}";
export const toolsSdkURL = "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v${version}/toolchain_${os}-${arch}_${toolchain}.${ext}";

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
	let os = undefined;
	let arch = undefined;
	let ext = undefined;
	
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

	if(os && arch) {
		if(type === 'full') {
			const fullUrl = `https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v${version}/zephyr-sdk-${version}_${os}-${arch}.${ext}`;
			urls.push(fullUrl);
		} else if(type === 'minimal') {
			const minUrl = `https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v${version}/zephyr-sdk-${version}_${os}-${arch}_minimal.${ext}`;
			urls.push(minUrl);

			for(let tArch of toolchains) {
				let toolchain = `${tArch}-zephyr-elf`;
				if(tArch === 'arm') {
					toolchain = `${tArch}-zephyr-eabi`;
				}
				const toolUrl = `https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v${version}/toolchain_${os}-${arch}_${toolchain}.${ext}`;
				urls.push(toolUrl);
			}
		} 
	}
	
	return urls;
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