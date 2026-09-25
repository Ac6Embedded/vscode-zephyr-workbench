// The allow-lists every toolchain download and folder name passes before it
// reaches a URL, a folder or a tar command line.

import { strict as assert } from 'assert';
import {
  ARCHIVE_BASENAME, assertArmGnuVersion, assertDownloadUrl, assertFolderName, assertReleaseNumber, assertRustTarget,
  assertSdkToolchainId, downloadUrlProblem, OFFICIAL_SOURCES,
} from '../../../mcp/core/downloadArgs';
import { McpToolError } from '../../../mcp/core/errors';

function code(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as McpToolError).code;
  }
}

// The workbench's own mapping, restated so the test stays pure.
const toPackage = (id: string) => (id === 'arm' ? 'arm-zephyr-eabi' : id.startsWith('xtensa-') ? `${id}_zephyr-elf` : `${id}-zephyr-elf`);

describe('mcp/core/downloadArgs', () => {
  describe('the archive name rule', () => {
    it('accepts the archives the official releases publish', () => {
      for (const name of [
        'zephyr-sdk-0.17.4_macos-aarch64_minimal.tar.xz',
        'toolchain_gnu_linux-x86_64_xtensa-espressif_esp32s3_zephyr-elf.tar.xz',
        'zephyr-sdk-1.0.0_windows-x86_64_gnu.7z',
        'clang+llvm-20.1.8-x86_64-pc-windows-msvc.tar.xz',
        'rust-std-1.87.0-thumbv8m.main-none-eabihf.tar.xz',
        'arm-gnu-toolchain-14.2.rel1-mingw-w64-x86_64-arm-none-eabi.zip',
        'winlibs-x86_64-posix-seh-gcc-14.2.0-mingw-w64ucrt-12.0.0-r3.zip',
        'archive.tar.gz', 'archive.tar.bz2',
      ]) {
        assert.ok(ARCHIVE_BASENAME.test(name), name);
      }
    });

    it('refuses names that could break out of the quoted tar argument', () => {
      for (const name of ['a"b.tar.xz', 'a$(id).tar.xz', 'a`id`.tar.xz', 'a b.tar.xz', 'a;b.zip', 'a%20b.7z', 'sdk.tar', 'sdk.exe', '.tar.xz']) {
        assert.ok(!ARCHIVE_BASENAME.test(name), name);
      }
    });
  });

  describe('downloadUrlProblem', () => {
    const sdk = [OFFICIAL_SOURCES.zephyrSdk];
    const good = 'https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v0.17.4/zephyr-sdk-0.17.4_linux-x86_64.tar.xz';

    it('accepts an official release archive', () => {
      assert.equal(downloadUrlProblem(good, sdk, { archive: true }), undefined);
    });

    it('refuses plain http, credentials and ports', () => {
      assert.match(downloadUrlProblem(good.replace('https:', 'http:'), sdk, { archive: true }) ?? '', /https/);
      assert.ok(downloadUrlProblem(good.replace('https://', 'https://user:pw@'), sdk, { archive: true }));
      assert.ok(downloadUrlProblem(good.replace('github.com', 'github.com:8443'), sdk, { archive: true }));
    });

    it('refuses another host, another repository, and a parent segment', () => {
      assert.match(downloadUrlProblem(good.replace('github.com', 'example.com'), sdk, { archive: true }) ?? '', /not an official/);
      assert.match(downloadUrlProblem(good.replace('zephyrproject-rtos/sdk-ng', 'someone/sdk-ng'), sdk, { archive: true }) ?? '', /not an official/);
      assert.ok(downloadUrlProblem('https://github.com/zephyrproject-rtos/sdk-ng/releases/download/../../x/a.tar.xz', sdk, { archive: true }));
    });

    it('checks the archive name, and a plain name for a binary', () => {
      assert.match(downloadUrlProblem(good.replace('.tar.xz', '.sh'), sdk, { archive: true }) ?? '', /archive name/);
      const rustup = 'https://static.rust-lang.org/rustup/dist/aarch64-apple-darwin/rustup-init';
      assert.equal(downloadUrlProblem(rustup, [OFFICIAL_SOURCES.rustupInit], { archive: false }), undefined);
      assert.ok(downloadUrlProblem(rustup, [OFFICIAL_SOURCES.rustupInit], { archive: true }));
    });

    it('lets a query string through, since the file is named after the path', () => {
      const arm = 'https://developer.arm.com/-/media/Files/downloads/gnu/14.2.rel1/binrel/arm-gnu-toolchain-14.2.rel1-darwin-arm64-arm-none-eabi.tar.xz?rev=1&hash=2';
      assert.equal(downloadUrlProblem(arm, [OFFICIAL_SOURCES.armGnu], { archive: true }), undefined);
    });

    it('throws INVALID_ARGUMENT with a hint from assertDownloadUrl', () => {
      assert.equal(code(() => assertDownloadUrl('https://evil.example/a.tar.xz', sdk, { archive: true })), 'INVALID_ARGUMENT');
      assert.equal(assertDownloadUrl(good, sdk, { archive: true }), good);
    });
  });

  it('takes release numbers with or without a leading v, and nothing else', () => {
    assert.equal(assertReleaseNumber('v0.17.4', 'version'), '0.17.4');
    assert.equal(assertReleaseNumber('1.87.0', 'version'), '1.87.0');
    for (const bad of ['0.17', '0.17.4-rc1', '0.17.4;id', 'latest', '../1.0.0']) {
      assert.equal(code(() => assertReleaseNumber(bad, 'version')), 'INVALID_ARGUMENT', bad);
    }
  });

  it('maps friendly SDK toolchain ids to package names and refuses anything else', () => {
    assert.equal(assertSdkToolchainId('arm', toPackage), 'arm-zephyr-eabi');
    assert.equal(assertSdkToolchainId('arm-zephyr-eabi', toPackage), 'arm-zephyr-eabi');
    assert.equal(assertSdkToolchainId('xtensa-espressif_esp32s3', toPackage), 'xtensa-espressif_esp32s3_zephyr-elf');
    for (const bad of ['arm zephyr', 'arm;id', '-t', '../arm', 'ARM$']) {
      assert.equal(code(() => assertSdkToolchainId(bad, toPackage)), 'INVALID_ARGUMENT', bad);
    }
  });

  it('accepts Rust target triples only', () => {
    for (const good of ['thumbv7em-none-eabihf', 'thumbv8m.main-none-eabi', 'riscv32i-unknown-none-elf', 'x86_64-unknown-none']) {
      assert.equal(assertRustTarget(good), good);
    }
    for (const bad of ['thumbv7em', 'thumbv7em-none-eabihf;id', 'a b-c', '../x-y']) {
      assert.equal(code(() => assertRustTarget(bad)), 'INVALID_ARGUMENT', bad);
    }
  });

  it('accepts Arm GNU releases as the catalog normalizes them', () => {
    assert.equal(assertArmGnuVersion('14.2.Rel1'), '14.2.rel1');
    assert.equal(assertArmGnuVersion('12.2.mpacbti-rel1'), '12.2.mpacbti-rel1');
    assert.equal(code(() => assertArmGnuVersion('14.2.rel1/../x')), 'INVALID_ARGUMENT');
  });

  it('takes one plain folder name', () => {
    assert.equal(assertFolderName(' rust-1.87.0-llvm-20.1.8 '), 'rust-1.87.0-llvm-20.1.8');
    for (const bad of ['.', '..', '...', 'a/b', 'a\\b', 'a b', '', 'x'.repeat(65), 'a"b']) {
      assert.equal(code(() => assertFolderName(bad)), 'INVALID_ARGUMENT', JSON.stringify(bad));
    }
  });
});
