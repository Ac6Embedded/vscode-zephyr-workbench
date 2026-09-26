// manage_toolchain: install, extend, register and link toolchains.

import { z } from 'zod';
import { ToolMeta } from '../toolSpec';
import { dryRun, waitSec } from './shared';

export const MANAGE_TOOLCHAIN: ToolMeta = {
  name: 'manage_toolchain',
  title: 'Install and register toolchains',
  description: [
    'Installs, extends, registers and links toolchains the way the Add Toolchain wizard and the Toolchains & Host Tools view of Zephyr Workbench do: an official Zephyr SDK into a folder or the global location (a global install skips the SDK host tools setup), extra GNU toolchains or LLVM for an installed SDK, an Arm GNU Toolchain release, a Rust toolchain through rustup or from standalone archives, the workbench managed rustup, and a host LLVM for Rust.',
    'Use action "install" or "add_components" to get a toolchain, "register" for one already on disk, and "link" to change the C toolchain or LLVM a Rust toolchain uses; list what can be installed with list_toolchains available, then select the toolchain of an application with configure.',
    'family picks what to install or register and version one of the versions list_toolchains available returns; downloads only come from the official release sites, and an IAR toolchain is registered without a licence token: one that needs a token is added by the user in the Add Toolchain wizard (open_in_workbench target add_toolchain).',
    'Returns a job for install and add_components, which can take several minutes and runs in a visible VS Code terminal, else the registered toolchain at once; the user approves in a VS Code dialog unless they chose not to be asked, and dry_run reports what would be downloaded and where.',
  ].join(' '),
  inputSchema: z.object({
    action: z.enum(['install', 'add_components', 'register', 'link']).describe(
      'install: download and register a toolchain; add_components: add GNU toolchains or LLVM to an installed Zephyr SDK; register: register a toolchain already on disk; link: change what a Rust toolchain is linked to.'),
    family: z.enum(['zephyr_sdk', 'arm_gnu', 'rust', 'rustup', 'llvm', 'iar']).optional().describe(
      'install: zephyr_sdk, arm_gnu, rust, rustup (the workbench managed rustup) or llvm (a host LLVM for the Rust toolchain rust_path); register: zephyr_sdk, arm_gnu or iar.'),
    version: z.string().optional().describe(
      'install only: the version to install, one of those list_toolchains available returns for the family, or stable for a Rust toolchain through rustup.'),
    destination: z.enum(['location', 'global']).optional().describe(
      'install with family zephyr_sdk: location (the default) installs into parent_path, global installs into the global Zephyr SDK location that west and CMake find on their own.'),
    parent_path: z.string().optional().describe(
      'install with destination location, family arm_gnu or a standalone Rust toolchain: absolute existing folder, without spaces, that receives the toolchain folder.'),
    install_base: z.string().optional().describe(
      'install with destination global: absolute base folder of the global install. Defaults to the recommended one for this machine.'),
    sdk_type: z.enum(['full', 'minimal']).optional().describe(
      'install with family zephyr_sdk: full (the default) installs every GNU toolchain, minimal only those in toolchains.'),
    toolchains: z.array(z.string()).max(40).optional().describe(
      'install with sdk_type minimal, and add_components: GNU toolchain ids such as arm-zephyr-eabi, as list_toolchains available zephyr_sdk with version lists them.'),
    llvm: z.boolean().optional().describe(
      'install with sdk_type minimal, and add_components: also install the LLVM toolchain of the SDK, offered from SDK 1.0.'),
    sdk_path: z.string().optional().describe(
      'add_components only: absolute root of the installed Zephyr SDK to extend, as list_toolchains returns it.'),
    arm_target: z.enum(['arm-none-eabi', 'aarch64-none-elf']).optional().describe(
      'install with family arm_gnu: the target of the release. Defaults to arm-none-eabi.'),
    folder_name: z.string().optional().describe(
      'install with family arm_gnu or a standalone Rust toolchain: name of the folder created in parent_path. Defaults to the release name.'),
    method: z.enum(['rustup', 'standalone']).optional().describe(
      'install with family rust: rustup (the default) installs through the workbench managed rustup, standalone unpacks the official archives into parent_path.'),
    targets: z.array(z.string()).max(40).optional().describe(
      'install with family rust: Rust targets such as thumbv7em-none-eabihf, as list_toolchains available rust lists them. Defaults to the minimal preset.'),
    c_toolchain: z.object({
      family: z.enum(['zephyr_sdk', 'arm_gnu']).describe('The family of the C toolchain the Rust toolchain links with.'),
      path: z.string().describe('Absolute root of that toolchain, as list_toolchains returns it.'),
    }).strict().optional().describe(
      'install with family rust, and link: the C toolchain the Rust toolchain uses to link Zephyr.'),
    llvm_version: z.string().optional().describe(
      'install with family rust or llvm: the host LLVM version to download, as list_toolchains available llvm lists them.'),
    install_mingw: z.boolean().optional().describe(
      'install with family rust and method standalone, on Windows only: also install the MinGW toolchain it needs.'),
    path: z.string().optional().describe(
      'register only: absolute root of the toolchain on disk.'),
    zephyr_sdk_path: z.string().optional().describe(
      'register with family iar: the registered Zephyr SDK the IAR toolchain is paired with, as list_toolchains returns it.'),
    rust_path: z.string().optional().describe(
      'link, and install with family llvm: absolute root of the Rust toolchain, as list_toolchains returns it.'),
    llvm_path: z.string().optional().describe(
      'link only: absolute folder of a host LLVM that contains libclang, to link to the Rust toolchain.'),
    unlink_llvm: z.boolean().optional().describe(
      'link only: remove the LLVM link of the Rust toolchain. Cannot be combined with llvm_path.'),
    dry_run: dryRun,
    wait_sec: waitSec,
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  category: 'action',
  toolsets: [],
  confirm: { install: 'install', add_components: 'install', register: 'settings', link: 'settings' },
  routeBy: [],
  machineScope: true,
};
