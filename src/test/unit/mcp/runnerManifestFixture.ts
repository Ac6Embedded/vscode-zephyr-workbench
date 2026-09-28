// A runner manifest with the shapes of scripts/runners/debug-tools.yml, whose
// detect paths only exist under the temporary host tools folder of a test, so
// no tool installed on the machine running the tests shows up.

import type { DebugToolsManifest } from '../../../utils/debugTools/debugToolVersionUtils';

const OS_ALL = {
  windows: { source: 'https://example.invalid/win.zip', sha256: 'SKIP' },
  linux: { source: 'https://example.invalid/linux.tgz', sha256: 'SKIP' },
  darwin: { source: 'https://example.invalid/mac.tgz', sha256: 'SKIP' },
};
const inZi = (dir: string) => ({ windows: [`\${zi_base_dir}/tools/${dir}`], linux: [`\${zi_base_dir}/tools/${dir}`], darwin: [`\${zi_base_dir}/tools/${dir}`] });

export const FAKE_MANIFEST = {
  aliases: [{ alias: 'openocd', name: 'OpenOCD', default: 'openocd-zephyr', ['version-command']: 'openocd --version' }],
  debug_tools: [
    { tool: 'openocd-zephyr', alias: 'openocd', name: 'OpenOCD Zephyr', version: '0.12.0', type: 'debug_server', group: 'Openocds/Zephyr', root: false, ['explicit-detect']: inZi('openocds/openocd-zephyr/bin'), os: OS_ALL },
    { tool: 'openocd-esp32', alias: 'openocd', name: 'OpenOCD ESP32', version: '0.12.0-esp32', root: false, ['explicit-detect']: inZi('openocds/openocd-esp32/bin'), os: OS_ALL },
    { tool: 'openocd-custom', alias: 'openocd', name: 'OpenOCD Custom', version: 'IGNORE', website: 'https://openocd.org/', os: { windows: false, linux: false, darwin: false } },
    {
      tool: 'jlink', name: 'J-Link Software', version: '9.54', website: 'https://www.segger.com/downloads/jlink/', vendor: 'Segger', group: 'Common', root: true,
      os: { windows: true, linux: true, darwin: true }, ['segger-sources']: { windows: 'https://www.segger.com/downloads/jlink/JLink_Windows.exe' },
    },
    { tool: 'stm32cubeprogrammer', name: 'STM32CubeProgrammer', version: '2.17.0', website: 'https://www.st.com/en/development-tools/stm32cubeprog.html', root: false },
    { tool: 'stm32cubeclt', name: 'STM32CubeCLT', version: '1.21.0', website: 'https://www.st.com/en/development-tools/stm32cubeclt.html', no_edit: true, runners: ['stlink_gdbserver'], ['explicit-detect']: inZi('st/STM32CubeCLT_*') },
    { tool: 'nrfutil', name: 'nRF Util', version: '8.1.1', root: false, os: OS_ALL },
    { tool: 'pyocd', name: 'pyOCD', version: '0.36.0', no_edit: true, os: { windows: true, linux: true, darwin: true } },
    { tool: 'cp210x', name: 'CP210x drivers', website: 'https://www.silabs.com/developer-tools/usb-to-uart-bridge-vcp-drivers', root: true, no_edit: true, os: { windows: OS_ALL.windows, linux: false, darwin: false } },
    { tool: 'udev-rules', name: 'Udev Rules', root: true, no_edit: true, os: { linux: OS_ALL.linux, windows: false, darwin: false } },
  ],
  packs: [
    { pack: 'stm32', name: 'STM32', tools: ['stm32cubeprogrammer', 'openocd-zephyr', 'jlink', 'udev-rules'] },
    { pack: 'esp32', name: 'ESP32', tools: ['openocd-esp32', 'cp210x'] },
  ],
} as unknown as DebugToolsManifest;
