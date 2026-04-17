import vscode, { ExtensionContext, QuickPickItem } from "vscode";
import { ZephyrProject } from "../models/ZephyrProject";
import { ZephyrToolchainVariant } from "../models/ZephyrSDK";
import { getListArmGnuToolchains, getListZephyrSDKs, getListIARs } from "../utils/utils";

export interface ToolchainPick {
    tcKind: "zephyr" | "iar" | "gnuarmemb";
    sdkPath?: string;
    iarPath?: string;
    armGnuPath?: string;
    toolchainVariant?: ZephyrToolchainVariant;
}

type TcItem = QuickPickItem & ToolchainPick;

export async function changeToolchainQuickStep(
    _ctx: ExtensionContext,
    _project: ZephyrProject
): Promise<ToolchainPick | undefined> {

    const items: TcItem[] = [];
    const sdks = await getListZephyrSDKs();

    for (const sdk of sdks) {
        items.push({
            label: `Zephyr SDK ${sdk.version.trim()}`,
            description: sdk.rootUri.fsPath,
            tcKind: "zephyr",
            sdkPath: sdk.rootUri.fsPath,
        });
    }

    for (const iar of await getListIARs()) {
        items.push({
            label: iar.name,
            description: iar.iarPath,
            tcKind: "iar",
            iarPath: iar.iarPath
        });
    }

    for (const armGnuToolchain of await getListArmGnuToolchains()) {
        items.push({
            label: armGnuToolchain.name,
            description: armGnuToolchain.toolchainPath,
            tcKind: "gnuarmemb",
            armGnuPath: armGnuToolchain.toolchainPath,
        });
    }

    const selection = await vscode.window.showQuickPick<TcItem>(items, {
        title: "Change Toolchain",
        placeHolder: "Select a toolchain"
    });

    if (!selection || selection.tcKind !== "zephyr" || !selection.sdkPath) {
        return selection;
    }

    const selectedSdk = sdks.find(sdk => sdk.rootUri.fsPath === selection.sdkPath);
    if (!selectedSdk?.hasLlvmToolchain()) {
        return { ...selection, toolchainVariant: "zephyr" };
    }

    const variant = await pickZephyrSdkVariant();
    if (!variant) {
        return undefined;
    }

    return { ...selection, toolchainVariant: variant };
}

async function pickZephyrSdkVariant(): Promise<ZephyrToolchainVariant | undefined> {
    const pick = await vscode.window.showQuickPick([
        {
            label: "GNU GCC",
            detail: "Sets ZEPHYR_TOOLCHAIN_VARIANT=zephyr",
            variant: "zephyr" as ZephyrToolchainVariant,
        },
        {
            label: "LLVM CLANG",
            detail: "Sets ZEPHYR_TOOLCHAIN_VARIANT=zephyr/llvm",
            variant: "zephyr/llvm" as ZephyrToolchainVariant,
        },
    ], {
        title: "SDK Variant",
        placeHolder: "Select the Zephyr SDK variant"
    });

    return pick?.variant;
}
