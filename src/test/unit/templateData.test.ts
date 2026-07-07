import assert from 'assert';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';
import {
  validateTemplateConfig,
  normalizeZephyrRevision,
  resolveBaseModules,
} from '../../utils/zephyr/templateData';

describe('normalizeZephyrRevision', () => {
  it('reduces tags to major.minor', () => {
    assert.strictEqual(normalizeZephyrRevision('v4.2.0'), '4.2');
    assert.strictEqual(normalizeZephyrRevision('V4.1.0'), '4.1');
    assert.strictEqual(normalizeZephyrRevision('4.1.0-rc1'), '4.1');
    assert.strictEqual(normalizeZephyrRevision('3.7'), '3.7');
    assert.strictEqual(normalizeZephyrRevision('  v3.7.1  '), '3.7');
  });

  it('returns undefined (latest) for branches, SHAs and empty input', () => {
    assert.strictEqual(normalizeZephyrRevision('main'), undefined);
    assert.strictEqual(normalizeZephyrRevision('collab-hwm'), undefined);
    assert.strictEqual(normalizeZephyrRevision('4b172430704e34c1c0b3ae2'), undefined);
    assert.strictEqual(normalizeZephyrRevision(''), undefined);
  });
});

describe('resolveBaseModules', () => {
  const baseModules = [
    { name: 'cmsis', untilZephyr: '4.0' },
    { name: 'cmsis_6', sinceZephyr: '4.1' },
    { name: 'picolibc' },
  ];

  it('keeps cmsis before Zephyr 4.1', () => {
    assert.deepStrictEqual(resolveBaseModules(baseModules, 'v3.7.0'), ['cmsis', 'picolibc']);
    assert.deepStrictEqual(resolveBaseModules(baseModules, 'v4.0.0'), ['cmsis', 'picolibc']);
  });

  it('switches to cmsis_6 from Zephyr 4.1', () => {
    assert.deepStrictEqual(resolveBaseModules(baseModules, 'v4.1.0'), ['cmsis_6', 'picolibc']);
    assert.deepStrictEqual(resolveBaseModules(baseModules, 'v4.3.1'), ['cmsis_6', 'picolibc']);
  });

  it('treats branches and unparseable refs as latest', () => {
    assert.deepStrictEqual(resolveBaseModules(baseModules, 'main'), ['cmsis_6', 'picolibc']);
    assert.deepStrictEqual(resolveBaseModules(baseModules, ''), ['cmsis_6', 'picolibc']);
  });
});

describe('validateTemplateConfig', () => {
  const validData = {
    manifest: {
      remotes: [{ name: 'zephyrproject', 'url-base': 'https://github.com/zephyrproject-rtos' }],
      projects: [{ name: 'zephyr', remote: 'zephyrproject', import: { 'path-prefix': 'deps' } }],
    },
    'base-modules': [
      { name: 'cmsis', 'until-zephyr': '4.0' },
      { name: 'cmsis_6', 'since-zephyr': '4.1' },
      { name: 'picolibc' },
    ],
    templates: [
      { label: 'Espressif', modules: ['hal_espressif', 'hal_xtensa'] },
      { label: 'STM32', modules: ['hal_stm32'], default: true },
    ],
  };

  it('preserves the declaration order of templates and base modules', () => {
    const config = validateTemplateConfig({
      ...validData,
      'base-modules': [{ name: 'zeta' }, { name: 'alpha' }, { name: 'mid' }],
      templates: [
        { label: 'Zulu', modules: ['hal_z'] },
        { label: 'Alpha', modules: ['hal_a'] },
        { label: 'Mike', modules: ['hal_m'] },
      ],
    });
    assert.deepStrictEqual(config.baseModules.map(module => module.name), ['zeta', 'alpha', 'mid']);
    assert.deepStrictEqual(config.templates.map(template => template.label), ['Zulu', 'Alpha', 'Mike']);
  });

  it('maps kebab-case keys onto the typed config', () => {
    const config = validateTemplateConfig(validData);
    assert.deepStrictEqual(config.baseModules[0], { name: 'cmsis', sinceZephyr: undefined, untilZephyr: '4.0' });
    assert.deepStrictEqual(config.baseModules[1], { name: 'cmsis_6', sinceZephyr: '4.1', untilZephyr: undefined });
    assert.deepStrictEqual(config.templates[0], { label: 'Espressif', modules: ['hal_espressif', 'hal_xtensa'] });
    assert.deepStrictEqual(config.templates[1], { label: 'STM32', modules: ['hal_stm32'], isDefault: true });
    assert.strictEqual(config.manifest, validData.manifest);
  });

  it('rejects malformed data with descriptive errors', () => {
    assert.throws(() => validateTemplateConfig(null), /YAML mapping/);
    assert.throws(() => validateTemplateConfig({ ...validData, manifest: undefined }), /"manifest"/);
    assert.throws(() => validateTemplateConfig({
      ...validData,
      manifest: { remotes: [{}], projects: [{ name: 'zephyr' }] },
    }), /import/);
    assert.throws(() => validateTemplateConfig({ ...validData, 'base-modules': [] }), /base-modules/);
    assert.throws(() => validateTemplateConfig({ ...validData, 'base-modules': [{ label: 'no name' }] }), /name/);
    assert.throws(() => validateTemplateConfig({
      ...validData,
      'base-modules': [{ name: 'percepio' }, { name: 'percepio' }],
    }), /duplicate module/);
    assert.throws(() => validateTemplateConfig({
      ...validData,
      'base-modules': [{ name: 'cmsis', 'until-zephyr': '4.0.0' }],
    }), /major\.minor/);
    assert.throws(() => validateTemplateConfig({ ...validData, templates: [] }), /templates/);
    assert.throws(() => validateTemplateConfig({ ...validData, templates: [{ modules: ['hal_stm32'] }] }), /label/);
    assert.throws(() => validateTemplateConfig({
      ...validData,
      templates: [{ label: 'STM32', modules: ['hal_stm32'] }, { label: 'STM32', modules: ['hal_stm32'] }],
    }), /duplicate/);
    assert.throws(() => validateTemplateConfig({ ...validData, templates: [{ label: 'STM32', modules: [] }] }), /modules/);
  });
});

describe('shipped west_manifests/templates.yml', () => {
  const templatesPath = path.join(__dirname, '..', '..', '..', 'west_manifests', 'templates.yml');
  const config = validateTemplateConfig(yaml.parse(fs.readFileSync(templatesPath, 'utf8')));

  it('switches the CMSIS base module on Zephyr 4.1', () => {
    const before = resolveBaseModules(config.baseModules, 'v4.0.0');
    const after = resolveBaseModules(config.baseModules, 'v4.1.0');
    assert.ok(before.includes('cmsis') && !before.includes('cmsis_6'));
    assert.ok(after.includes('cmsis_6') && !after.includes('cmsis'));
  });

  it('adds tf-psa-crypto alongside mbedtls only from Zephyr 4.4', () => {
    const released = resolveBaseModules(config.baseModules, 'v4.3.0');
    const latest = resolveBaseModules(config.baseModules, 'main');
    assert.ok(released.includes('mbedtls') && !released.includes('tf-psa-crypto'));
    assert.ok(latest.includes('mbedtls') && latest.includes('tf-psa-crypto'));
  });

  it('includes hal_xtensa in the Espressif template', () => {
    const espressif = config.templates.find(template => template.label === 'Espressif');
    assert.deepStrictEqual(espressif?.modules, ['hal_espressif', 'hal_xtensa']);
  });

  it('marks exactly one default template (STM32)', () => {
    const defaults = config.templates.filter(template => template.isDefault);
    assert.deepStrictEqual(defaults.map(template => template.label), ['STM32']);
  });
});
