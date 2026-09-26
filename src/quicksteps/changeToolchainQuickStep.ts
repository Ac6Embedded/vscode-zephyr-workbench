import vscode, { ExtensionContext, QuickPickItem } from "vscode";
import { ZephyrApplication } from "../models/ZephyrApplication";
import { ZephyrSdkVariantId } from "../models/ToolchainInstallations";
import {
    ApplicationToolchainChoice,
    lacksCToolchain,
    listApplicationToolchainChoices,
    resolveChoiceSdk,
    ToolchainVariantPick,
} from "../utils/zephyr/applicationToolchain";

export type { ToolchainVariantPick };

type ToolchainVariantQuickPickItem = QuickPickItem & ToolchainVariantPick & { choice: ApplicationToolchainChoice };

export async function changeToolchainQuickStep(
    _ctx: ExtensionContext,
    project: ZephyrApplication
): Promise<ToolchainVariantPick | undefined> {

    const items: ToolchainVariantQuickPickItem[] = (await listApplicationToolchainChoices(project)).map(choice => ({
        label: choice.label,
        description: choice.description,
        selectedVariant: choice.selectedVariant,
        zephyrSdkPath: choice.zephyrSdkPath,
        iarToolchainPath: choice.iarToolchainPath,
        armGnuToolchainPath: choice.armGnuToolchainPath,
        rustToolchainPath: choice.rustToolchainPath,
        choice,
    }));

    const selection = await vscode.window.showQuickPick<ToolchainVariantQuickPickItem>(items, {
        title: "Change Toolchain Variant",
        placeHolder: "Select a toolchain installation"
    });

    if (selection && lacksCToolchain(selection)) {
        vscode.window.showErrorMessage(
            "This Rust toolchain has no linked C toolchain; right-click it in the Toolchains & Host Tools view to link one."
        );
        return undefined;
    }

    if (!selection || selection.selectedVariant !== "zephyr" || !selection.zephyrSdkPath) {
        return selection;
    }

    const selectedSdk = resolveChoiceSdk(project, selection.choice);
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
