import vscode, { ExtensionContext, QuickPickItem } from "vscode";
import { ZephyrProject } from "./ZephyrProject";
import { getListZephyrSDKs, getListIARs } from "./utils";

export interface ToolchainPick {
    tcKind: "zephyr_sdk" | "iar";
    sdkPath?: string;
    iarPath?: string;
}

type TcItem = QuickPickItem & ToolchainPick;

export async function changeToolchainQuickStep(
    _ctx: ExtensionContext,
    _project: ZephyrProject
): Promise<ToolchainPick | undefined> {

    const items: TcItem[] = [];

    for (const sdk of await getListZephyrSDKs()) {
        items.push({
            label: `Zephyr SDK ${sdk.version}`,
            description: sdk.rootUri.fsPath,
            tcKind: "zephyr_sdk",
            sdkPath: sdk.rootUri.fsPath
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

    return vscode.window.showQuickPick<TcItem>(items, {
        title: "Change Toolchain",
        placeHolder: "Select a toolchain"
    });
}
