import { strict as assert } from 'assert';

import { detectGuiSudoAvailability } from '../../utils/environmentUtils';

describe('detectGuiSudoAvailability', () => {
  it('always allows the GUI prompt on macOS, regardless of display or remote', () => {
    assert.deepEqual(detectGuiSudoAvailability('darwin', 'ssh-remote', {}), { available: true });
  });

  it('always allows the GUI prompt on Windows', () => {
    assert.deepEqual(detectGuiSudoAvailability('win32', undefined, {}), { available: true });
  });

  it('allows the GUI prompt on local Linux with an X11 display', () => {
    assert.deepEqual(
      detectGuiSudoAvailability('linux', undefined, { DISPLAY: ':0' }),
      { available: true }
    );
  });

  it('allows the GUI prompt on local Linux with a Wayland display', () => {
    assert.deepEqual(
      detectGuiSudoAvailability('linux', undefined, { WAYLAND_DISPLAY: 'wayland-0' }),
      { available: true }
    );
  });

  it('falls back to terminal in WSL (remoteName = wsl)', () => {
    assert.deepEqual(
      detectGuiSudoAvailability('linux', 'wsl', { DISPLAY: ':0' }),
      { available: false, reason: 'remote' }
    );
  });

  it('falls back to terminal over remote-SSH even when a display is exported', () => {
    assert.deepEqual(
      detectGuiSudoAvailability('linux', 'ssh-remote', { DISPLAY: ':0' }),
      { available: false, reason: 'remote' }
    );
  });

  it('falls back to terminal when WSL_DISTRO_NAME is set but remoteName is empty', () => {
    assert.deepEqual(
      detectGuiSudoAvailability('linux', undefined, { WSL_DISTRO_NAME: 'Ubuntu-24.04' }),
      { available: false, reason: 'remote' }
    );
  });

  it('falls back to terminal on headless local Linux (no display)', () => {
    assert.deepEqual(
      detectGuiSudoAvailability('linux', undefined, {}),
      { available: false, reason: 'headless' }
    );
  });
});
