import vscode, { ExtensionContext, QuickPickItem } from "vscode";
import { ZephyrApplication } from "../models/ZephyrApplication";
import { ToolchainVariantId, ZephyrSdkVariantId } from "../models/ToolchainInstallations";
import { getRegisteredArmGnuToolchainInstallations, getRegisteredZephyrSdkInstallations, getRegisteredIarToolchainInstallations } from "../utils/utils";

export interface ToolchainVariantPick {
    selectedVariant: ToolchainVariantId;
    zephyrSdkPath?: string;
    iarToolchainPath?: string;
    armGnuToolchainPath?: string;
}

type ToolchainVariantQuickPickItem = QuickPickItem & ToolchainVariantPick;

export async function changeToolchainQuickStep(
    _ctx: ExtensionContext,
    _project: ZephyrApplication
): Promise<ToolchainVariantPick | undefined> {

    const items: ToolchainVariantQuickPickItem[] = [];
    const sdks = await getRegisteredZephyrSdkInstallations();

    for (const sdk of sdks) {
        items.push({
            label: `Zephyr SDK ${sdk.version.trim()}`,
            description: sdk.rootUri.fsPath,
            selectedVariant: "zephyr",
            zephyrSdkPath: sdk.rootUri.fsPath,
        });
    }

    for (const iar of await getRegisteredIarToolchainInstallations()) {
        items.push({
            label: iar.name,
            description: iar.iarPath,
            selectedVariant: "iar",
            iarToolchainPath: iar.iarPath
        });
    }

    for (const armGnuToolchain of await getRegisteredArmGnuToolchainInstallations()) {
        items.push({
            label: armGnuToolchain.name,
            description: armGnuToolchain.toolchainPath,
            selectedVariant: "gnuarmemb",
            armGnuToolchainPath: armGnuToolchain.toolchainPath,
        });
    }

    const selection = await vscode.window.showQuickPick<ToolchainVariantQuickPickItem>(items, {
        title: "Change Toolchain Variant",
        placeHolder: "Select a toolchain installation"
    });

    if (!selection || selection.selectedVariant !== "zephyr" || !selection.zephyrSdkPath) {
        return selection;
    }

    const selectedSdk = sdks.find(sdk => sdk.rootUri.fsPath === selection.zephyrSdkPath);
    if (!selectedSdk?.hasLlvmToolchain()) {
        return { ...selection, selectedVariant: "zephyr" };
    }

    const variant = await pickZephyrSdkVariant();
    if (!variant) {
        return undefined;
    }

    return { ...selection, selectedVariant: variant };
}

async function pickZephyrSdkVariant(): Promise<ZephyrSdkVariantId | undefined> {
    const pick = await vscode.window.showQuickPick([
        {
            label: "GNU GCC",
            detail: "Sets ZEPHYR_TOOLCHAIN_VARIANT=zephyr",
            variant: "zephyr" as ZephyrSdkVariantId,
        },
        {
            label: "LLVM CLANG",
            detail: "Sets ZEPHYR_TOOLCHAIN_VARIANT=zephyr/llvm",
            variant: "zephyr/llvm" as ZephyrSdkVariantId,
        },
    ], {
        title: "SDK Variant",
        placeHolder: "Select the Zephyr SDK variant"
    });

    return pick?.variant;
}
