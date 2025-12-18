const assert = require('assert');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

/**
* Auxiliary function to generate west.yml
* (isolated, without vscode)
*/
function generateWestManifestTest(
  remotePath: string,
  remoteBranch: string,
  workspacePath: string,
  templateHal: string,
  isFull: boolean
) {
  let manifestYaml: any;

  if (isFull) {
    manifestYaml = {
      manifest: {
        remotes: [
          {
            name: 'zephyrproject',
            'url-base': 'https://github.com/zephyrproject-rtos',
          },
        ],
        projects: [
          {
            name: 'zephyr',
            'repo-path': 'zephyr',
            remote: 'zephyrproject',
            revision: remoteBranch,
            import: {
              'path-prefix': 'deps',
            },
          },
        ],
      },
    };
  } else {
    // Minimum manifest based on expected file
    const templateFile = fs.readFileSync(
      path.join(__dirname, 'expected_minimal.yml'),
      'utf8'
    );

    manifestYaml = yaml.parse(templateFile);

    manifestYaml.manifest.remotes[0]['url-base'] = remotePath;
    manifestYaml.manifest.projects[0].revision = remoteBranch;

    if (
      manifestYaml.manifest.projects[0].import &&
      manifestYaml.manifest.projects[0].import['name-allowlist'] &&
      !manifestYaml.manifest.projects[0].import['name-allowlist'].includes(templateHal)
    ) {
      manifestYaml.manifest.projects[0].import['name-allowlist'].push(templateHal);
    }
  }

  // Create directories
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true });
  }

  const manifestDir = path.join(workspacePath, 'manifest');
  if (!fs.existsSync(manifestDir)) {
    fs.mkdirSync(manifestDir, { recursive: true });
  }

  const destFilePath = path.join(manifestDir, 'west.yml');
  const westManifestContent = yaml.stringify(manifestYaml);

  fs.writeFileSync(destFilePath, westManifestContent, 'utf8');

  return destFilePath;
}

describe('Manifest output comparison', () => {
  const tmpRoot = path.join(__dirname, 'tmp-workspace-compare');

  const remotePath = 'https://github.com/zephyrproject-rtos';
  const remoteBranch = 'v4.3.0';
  const templateHal = 'hal_stm32';

  // Create expected files to test it
  before(() => {
    // FULL
    const expectedFull = {
      manifest: {
        remotes: [
          { name: 'zephyrproject', 'url-base': remotePath },
        ],
        projects: [
          {
            name: 'zephyr',
            'repo-path': 'zephyr',
            remote: 'zephyrproject',
            revision: remoteBranch,
            import: { 'path-prefix': 'deps' },
          },
        ],
      },
    };
    fs.writeFileSync(
      path.join(__dirname, 'expected_full.yml'),
      yaml.stringify(expectedFull),
      'utf8'
    );

    // MINIMAL (estrutura exata do exemplo do usuário)
    const expectedMinimal = {
      manifest: {
        remotes: [
          { name: 'zephyrproject', 'url-base': remotePath },
        ],
        projects: [
          {
            name: 'zephyr',
            'repo-path': 'zephyr',
            remote: 'zephyrproject',
            revision: remoteBranch,
            import: {
              'path-prefix': 'deps',
              'name-allowlist': [
                'cmsis',
                'cmsis-dsp',
                'cmsis_6',
                'percepio',
                'picolibc',
                'segger',
                'hal_stm32',
              ],
            },
          },
        ],
      },
    };
    fs.writeFileSync(
      path.join(__dirname, 'expected_minimal.yml'),
      yaml.stringify(expectedMinimal),
      'utf8'
    );
  });

  afterEach(() => {
    if (fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('should match FULL manifest with expected_full.yml', () => {
    const workspacePath = path.join(tmpRoot, 'full');

    const manifestPath = generateWestManifestTest(
      remotePath,
      remoteBranch,
      workspacePath,
      templateHal,
      true
    );

    const content = fs.readFileSync(manifestPath, 'utf8');
    const parsed = yaml.parse(content);

    const expected = yaml.parse(
      fs.readFileSync(path.join(__dirname, 'expected_full.yml'), 'utf8')
    );

    assert.deepStrictEqual(parsed, expected);
  });

  it('should match MINIMAL manifest with expected_minimal.yml', () => {
    const workspacePath = path.join(tmpRoot, 'minimal');

    const manifestPath = generateWestManifestTest(
      remotePath,
      remoteBranch,
      workspacePath,
      templateHal,
      false
    );

    const content = fs.readFileSync(manifestPath, 'utf8');
    const parsed = yaml.parse(content);

    const expected = yaml.parse(
      fs.readFileSync(path.join(__dirname, 'expected_minimal.yml'), 'utf8')
    );

    assert.deepStrictEqual(parsed, expected);
  });
});
