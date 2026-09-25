import { strict as assert } from 'assert';

import {
  buildArmGnuDownloadCatalog,
  buildArmGnuDownloadUrl,
  filterArmGnuCatalogForHost,
} from '../../utils/zephyr/armGnuToolchainUtils';

const REGISTRY = 'https://gitlab.arm.com/api/v4/projects/10698/packages/generic/gnu-toolchain';

/** The archive of each host and target, with the signature files Arm publishes next to it. */
function releaseFiles(version: string, variants: string[]): string[] {
  return variants.flatMap(variant => {
    const archive = `arm-gnu-toolchain-${version}-${variant}`;
    return [archive, `${archive}.asc`, `${archive}.sha256asc`];
  });
}

describe('buildArmGnuDownloadCatalog', () => {
  it('lists the bare-metal archives of the supported hosts, newest release first', () => {
    const catalog = buildArmGnuDownloadCatalog([
      { version: '14.2.rel1', fileNames: releaseFiles('14.2.rel1', ['darwin-arm64-arm-none-eabi.tar.xz']) },
      {
        version: '15.2.rel1',
        fileNames: releaseFiles('15.2.rel1', [
          'darwin-arm64-arm-none-eabi.tar.xz',
          'darwin-arm64-arm-none-eabi.pkg',
          'x86_64-aarch64-none-elf.tar.xz',
          'x86_64-arm-none-linux-gnueabihf.tar.xz',
          'mingw-w64-x86_64-arm-none-eabi.zip',
          'mingw-w64-x86_64-arm-none-eabi.msi',
          'mingw-w64-i686-arm-none-eabi.zip',
          'aarch64-arm-none-eabi.tar.xz',
        ]),
      },
    ]);

    assert.deepEqual(catalog.releases, [
      { version: '15.2.rel1', displayVersion: '15.2.rel1' },
      { version: '14.2.rel1', displayVersion: '14.2.rel1' },
    ]);
    assert.deepEqual(
      catalog.assets.map(asset => [asset.version, asset.hostId, asset.targetTriple, asset.filename]),
      [
        ['15.2.rel1', 'darwin-arm64', 'arm-none-eabi', 'arm-gnu-toolchain-15.2.rel1-darwin-arm64-arm-none-eabi.tar.xz'],
        ['15.2.rel1', 'x86_64', 'aarch64-none-elf', 'arm-gnu-toolchain-15.2.rel1-x86_64-aarch64-none-elf.tar.xz'],
        ['15.2.rel1', 'mingw-w64-x86_64', 'arm-none-eabi', 'arm-gnu-toolchain-15.2.rel1-mingw-w64-x86_64-arm-none-eabi.zip'],
        ['14.2.rel1', 'darwin-arm64', 'arm-none-eabi', 'arm-gnu-toolchain-14.2.rel1-darwin-arm64-arm-none-eabi.tar.xz'],
      ],
    );
    assert.equal(
      catalog.assets[0].url,
      `${REGISTRY}/15.2.rel1/arm-gnu-toolchain-15.2.rel1-darwin-arm64-arm-none-eabi.tar.xz`,
    );
  });

  it('keeps macOS Intel archives off the x86_64 Linux host', () => {
    const catalog = buildArmGnuDownloadCatalog([
      { version: '13.3.rel1', fileNames: releaseFiles('13.3.rel1', ['darwin-x86_64-arm-none-eabi.tar.xz']) },
    ]);

    assert.deepEqual(catalog, { releases: [], assets: [] });
  });

  it('downloads a release by its exact package version, which the registry matches case-sensitively', () => {
    const catalog = buildArmGnuDownloadCatalog([
      { version: '13.2.Rel1', fileNames: releaseFiles('13.2.Rel1', ['x86_64-arm-none-eabi.tar.xz']) },
    ]);

    assert.deepEqual(catalog.releases, [{ version: '13.2.rel1', displayVersion: '13.2.Rel1' }]);
    assert.equal(
      catalog.assets[0].url,
      `${REGISTRY}/13.2.Rel1/arm-gnu-toolchain-13.2.Rel1-x86_64-arm-none-eabi.tar.xz`,
    );
  });

  it('lists a file uploaded several times once', () => {
    const files = releaseFiles('15.3.rel1', ['x86_64-arm-none-eabi.tar.xz']);
    const catalog = buildArmGnuDownloadCatalog([{ version: '15.3.rel1', fileNames: [...files, ...files] }]);

    assert.equal(catalog.assets.length, 1);
  });

  it('orders releases of the same GCC version as Arm does, and leaves out ones without an archive', () => {
    const catalog = buildArmGnuDownloadCatalog(['12.2.mpacbti-bet1', '11.2-2022.02', '12.2.rel1', '12.3.rel1', '12.2.mpacbti-rel1']
      .map(version => ({
        version,
        // 11.2-2022.02 still used the gcc-arm- prefix.
        fileNames: version.startsWith('11.')
          ? [`gcc-arm-${version}-x86_64-arm-none-eabi.tar.xz`]
          : releaseFiles(version, ['x86_64-arm-none-eabi.tar.xz']),
      })));

    assert.deepEqual(
      catalog.releases.map(release => release.version),
      ['12.3.rel1', '12.2.rel1', '12.2.mpacbti-rel1', '12.2.mpacbti-bet1'],
    );
  });
});

describe('filterArmGnuCatalogForHost', () => {
  it('keeps the releases that have an archive for the host', () => {
    const catalog = buildArmGnuDownloadCatalog([
      { version: '15.2.rel1', fileNames: releaseFiles('15.2.rel1', ['darwin-arm64-arm-none-eabi.tar.xz', 'x86_64-arm-none-eabi.tar.xz']) },
      { version: '12.2.rel1', fileNames: releaseFiles('12.2.rel1', ['x86_64-arm-none-eabi.tar.xz']) },
    ]);

    const darwin = filterArmGnuCatalogForHost(catalog, 'darwin-arm64');

    assert.deepEqual(darwin.releases.map(release => release.version), ['15.2.rel1']);
    assert.deepEqual(darwin.assets.map(asset => asset.hostId), ['darwin-arm64']);
  });
});

describe('buildArmGnuDownloadUrl', () => {
  it('points at the release package in the Arm GitLab registry', () => {
    assert.equal(
      buildArmGnuDownloadUrl('14.2.rel1', 'mingw-w64-x86_64', 'arm-none-eabi'),
      `${REGISTRY}/14.2.rel1/arm-gnu-toolchain-14.2.rel1-mingw-w64-x86_64-arm-none-eabi.zip`,
    );
  });
});
