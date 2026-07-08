import * as vscode from "vscode";
import { QuickPickItem } from "vscode";
import { ZephyrApplication } from "../models/ZephyrApplication";
import {
    IntelliSenseProviderId,
    isClangdInstalled,
    isCppToolsInstalled,
} from "../utils/intellisense/providerAvailability";

type IntelliSenseProviderPickItem = QuickPickItem & { provider: IntelliSenseProviderId };

/**
 * Ask which IntelliSense provider an application should use. Both providers are
 * always offered (their generated files stay inert until the matching extension
 * is installed), so there is no blocking warning when a provider is absent; the
 * description just notes whether it is installed.
 */
export async function changeIntellisenseQuickStep(
    project: ZephyrApplication
): Promise<IntelliSenseProviderId | undefined> {
    const current = project.intellisenseProvider;
    const items: IntelliSenseProviderPickItem[] = [
        {
            label: `${current === 'cpptools' ? '$(check) ' : ''}C/C++ extension (cpptools)`,
            description: isCppToolsInstalled() ? 'installed' : 'not installed',
            provider: 'cpptools',
        },
        {
            label: `${current === 'clangd' ? '$(check) ' : ''}clangd`,
            description: isClangdInstalled() ? 'installed' : 'not installed',
            provider: 'clangd',
        },
    ];

    const selection = await vscode.window.showQuickPick<IntelliSenseProviderPickItem>(items, {
        title: "Change IntelliSense Provider",
        placeHolder: "Select the IntelliSense provider for this application",
    });

    return selection?.provider;
}
