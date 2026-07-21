import { strict as assert } from 'assert';

import {
  DebugNameProject,
  getDebugLaunchConfigurationName,
  extractDebugBuildConfigName,
  extractDebugDomainName,
  extractWorkspaceApplicationPathFromDebugConfigName,
} from '../../utils/debugTools/debugConfigNames';

function workspaceProject(relApp: string): DebugNameProject {
  // appWorkspaceFolder is the west root; appRootPath = root/<relApp>.
  const root = '/ws/root';
  return {
    isWestWorkspaceApplication: true,
    appName: relApp.split('/').pop() ?? relApp,
    appRootPath: `${root}/${relApp}`,
    appWorkspaceFolder: { uri: { fsPath: root } },
  };
}

function freestandingProject(): DebugNameProject {
  return {
    isWestWorkspaceApplication: false,
    appName: 'blinky',
    appRootPath: '/apps/blinky',
    appWorkspaceFolder: { uri: { fsPath: '/apps/blinky' } },
  };
}

describe('debugConfigNames', () => {
  describe('name construction (non-sysbuild is byte-identical to before)', () => {
    it('workspace app, no domain', () => {
      assert.equal(
        getDebugLaunchConfigurationName(workspaceProject('applications/hello_world'), 'debug'),
        'Zephyr Workbench Debug: applications/hello_world [debug]',
      );
    });

    it('freestanding app, no domain', () => {
      assert.equal(
        getDebugLaunchConfigurationName(freestandingProject(), 'debug'),
        'Zephyr Workbench Debug [debug]',
      );
    });

    it('appends the domain only when both config and domain are present', () => {
      assert.equal(
        getDebugLaunchConfigurationName(workspaceProject('applications/hello_world_sysbuild'), 'primary', 'mcuboot'),
        'Zephyr Workbench Debug: applications/hello_world_sysbuild [primary] (mcuboot)',
      );
      // domain without a config name is ignored (no config = no suffix at all)
      assert.equal(
        getDebugLaunchConfigurationName(workspaceProject('applications/x'), undefined, 'mcuboot'),
        'Zephyr Workbench Debug: applications/x',
      );
    });
  });

  describe('round-trip extraction', () => {
    it('extracts config and domain from a suffixed name', () => {
      const name = 'Zephyr Workbench Debug: applications/hws [primary] (mcuboot)';
      assert.equal(extractDebugBuildConfigName(name), 'primary');
      assert.equal(extractDebugDomainName(name), 'mcuboot');
      assert.equal(extractWorkspaceApplicationPathFromDebugConfigName(name), 'applications/hws');
    });

    it('extracts config and no domain from an unsuffixed name', () => {
      const name = 'Zephyr Workbench Debug: apps/blinky [debug]';
      assert.equal(extractDebugBuildConfigName(name), 'debug');
      assert.equal(extractDebugDomainName(name), undefined);
      assert.equal(extractWorkspaceApplicationPathFromDebugConfigName(name), 'apps/blinky');
    });

    it('handles a config name that itself contains parentheses', () => {
      const name = 'Zephyr Workbench Debug [primary (v2)]';
      assert.equal(extractDebugBuildConfigName(name), 'primary (v2)');
      assert.equal(extractDebugDomainName(name), undefined);
    });

    it('handles a parenthesized config name plus a domain', () => {
      const name = 'Zephyr Workbench Debug [primary (v2)] (mcuboot)';
      assert.equal(extractDebugBuildConfigName(name), 'primary (v2)');
      assert.equal(extractDebugDomainName(name), 'mcuboot');
    });

    it('freestanding names have no workspace app path', () => {
      assert.equal(extractWorkspaceApplicationPathFromDebugConfigName('Zephyr Workbench Debug [debug] (mcuboot)'), undefined);
    });
  });
});
