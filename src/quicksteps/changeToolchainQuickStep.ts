import vscode, { ExtensionContext, QuickPickItem } from "vscode";
import { ZephyrApplication } from "../models/ZephyrApplication";
import { ToolchainVariantId, ZephyrSdkVariantId } from "../models/ToolchainInstallations";
import { getAllZephyrSdkInstallations, getRegisteredArmGnuToolchainInstallations, getRegisteredRustToolchainInstallations, getRegisteredIarToolchainInstallations, getWestWorkspace } from "../utils/utils";
import { getCachedGlobalSdks, resolveDefaultGlobalSdk, resolveGlobalSdkForZephyr } from "../utils/zephyr/globalSdkService";
import { ZEPHYR_PROJECT_SDK_GLOBAL_VALUE } from "../constants";
import path from "path";

export interface ToolchainVariantPick {
    selectedVariant: ToolchainVariantId;
    zephyrSdkPath?: string;
    iarToolchainPath?: string;
    armGnuToolchainPath?: string;
    rustToolchainPath?: string;
}

type ToolchainVariantQuickPickItem = QuickPickItem & ToolchainVariantPick;

export async function changeToolchainQuickStep(
    _ctx: ExtensionContext,
    project: ZephyrApplication
): Promise<ToolchainVariantPick | undefined> {

    const items: ToolchainVariantQuickPickItem[] = [];
    // Registered SDKs plus auto-detected global ones (each pickable as a
    // pinned path), preceded by the pathless "use whatever is global" entry.
    const sdks = await getAllZephyrSdkInstallations();

    const newestGlobal = resolveDefaultGlobalSdk();
    if (getCachedGlobalSdks().length > 0) {
        items.push({
            label: "Global Zephyr SDK",
            description: newestGlobal
                ? `auto-detected at build time (currently Zephyr SDK ${newestGlobal.version.trim()})`
                : "auto-detected at build time",
            selectedVariant: "zephyr",
            zephyrSdkPath: ZEPHYR_PROJECT_SDK_GLOBAL_VALUE,
        });
    }

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

    for (const rustToolchain of await getRegisteredRustToolchainInstallations()) {
        const linkedName = rustToolchain.cToolchainPath
            ? path.basename(rustToolchain.cToolchainPath)
            : 'no C toolchain linked';
        // A Rust pick is a normal C toolchain pick (derived from the link)
        // that additionally pins the app's Rust toolchain path; SDK links go
        // through the same GNU/LLVM sub-step as picking the SDK directly.
        items.push({
            label: rustToolchain.name,
            description: `+ ${linkedName}`,
            selectedVariant: rustToolchain.cToolchainType === 'gnuarmemb' ? 'gnuarmemb' : 'zephyr',
            zephyrSdkPath: rustToolchain.cToolchainType === 'zephyr-sdk' ? rustToolchain.cToolchainPath : undefined,
            armGnuToolchainPath: rustToolchain.cToolchainType === 'gnuarmemb' ? rustToolchain.cToolchainPath : undefined,
            rustToolchainPath: rustToolchain.toolchainPath,
        });
    }

    const selection = await vscode.window.showQuickPick<ToolchainVariantQuickPickItem>(items, {
        title: "Change Toolchain Variant",
        placeHolder: "Select a toolchain installation"
    });

    if (selection?.rustToolchainPath && !selection.zephyrSdkPath && !selection.armGnuToolchainPath) {
        vscode.window.showErrorMessage(
            "This Rust toolchain has no linked C toolchain; right-click it in the Toolchains view to link one."
        );
        return undefined;
    }

    if (!selection || selection.selectedVariant !== "zephyr" || !selection.zephyrSdkPath) {
        return selection;
    }

    // For the global pick, gate the LLVM sub-step on the SDK the build would
    // actually use (newest COMPATIBLE with the app's Zephyr, like every other
    // global resolution), not simply the newest detected one.
    let selectedSdk;
    if (selection.zephyrSdkPath === ZEPHYR_PROJECT_SDK_GLOBAL_VALUE) {
        let kernelPath: string | undefined;
        try {
            kernelPath = project.westWorkspaceRootPath
                ? getWestWorkspace(project.westWorkspaceRootPath).kernelUri.fsPath
                : undefined;
        } catch {
            kernelPath = undefined;
        }
        selectedSdk = resolveGlobalSdkForZephyr(kernelPath);
    } else {
        selectedSdk = sdks.find(sdk => sdk.rootUri.fsPath === selection.zephyrSdkPath);
    }
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
