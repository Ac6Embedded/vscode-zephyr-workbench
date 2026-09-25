// Reads everything a finished build left behind, in one call.
//
// The logic was previously inline in ZephyrDashboardViewProvider._resolveTarget.
// It lives here so the dashboard webview and the MCP `get_build_info` tool
// cannot drift apart, and so it stays unit testable: this module takes explicit
// paths and imports no `vscode`.

import * as fs from 'fs';
import { readZephyrBuildSummary, readZephyrStatFile, ZephyrBuildSummary, ZephyrStatFileContent } from './buildSummaryParser';
import { readZephyrMemoryReport, ZephyrMemoryReport } from './memoryReportParser';
import { readZephyrMemoryTreeReport, ZephyrMemoryTreeReport } from './memoryTreeParser';
import { readZephyrDeviceTreeReport, ZephyrDeviceTreeReport } from './dtsReportParser';
import { readZephyrKconfigReport, ZephyrKconfigReport } from './kconfigReportParser';
import { readZephyrSysInitReport, ZephyrSysInitReport } from './sysInitParser';

export interface BuildReportPaths {
  buildDir: string;
  elfPath?: string;
  binPath?: string;
  hexPath?: string;
  mapPath?: string;
  dotConfigPath?: string;
  cmakeCachePath?: string;
  buildInfoPath?: string;
  metaPath?: string;
  statPath?: string;
  dtsPath?: string;
  traceJsonPath?: string;
  devicetreeHeaderPath?: string;
  westWorkspaceRoot?: string;
  appRootPath?: string;
}

export type BuildReportSection = 'summary' | 'memory' | 'memoryTree' | 'deviceTree' | 'kconfig' | 'sysInit' | 'elfStat';

export interface BuildReport {
  buildDir: string;
  configured: boolean;
  built: boolean;
  summary?: ZephyrBuildSummary;
  memory?: ZephyrMemoryReport;
  memoryTree?: ZephyrMemoryTreeReport;
  deviceTree?: ZephyrDeviceTreeReport;
  kconfig?: ZephyrKconfigReport;
  sysInit?: ZephyrSysInitReport;
  elfStat?: ZephyrStatFileContent;
  /** One entry per section that could not be read, so a caller can report why. */
  errors: Partial<Record<BuildReportSection, string>>;
}

function attempt<T>(
  report: BuildReport, section: BuildReportSection, read: () => T | undefined,
): T | undefined {
  try {
    return read();
  } catch (error) {
    report.errors[section] = error instanceof Error ? error.message : String(error);
    return undefined;
  }
}

/**
 * Read the requested sections. Every section is independent: a missing ELF
 * still lets the devicetree and Kconfig sections come back, which matters
 * because a configure-only build has those but no binary.
 */
export function collectBuildReport(paths: BuildReportPaths, sections: readonly BuildReportSection[]): BuildReport {
  const wanted = new Set(sections);
  const report: BuildReport = {
    buildDir: paths.buildDir,
    configured: !!paths.cmakeCachePath && fs.existsSync(paths.cmakeCachePath),
    built: !!paths.elfPath && fs.existsSync(paths.elfPath),
    errors: {},
  };

  if (wanted.has('summary')) {
    report.summary = attempt(report, 'summary', () => readZephyrBuildSummary({
      buildDir: paths.buildDir,
      elfPath: paths.elfPath,
      binPath: paths.binPath,
      hexPath: paths.hexPath,
      mapPath: paths.mapPath,
      dotConfigPath: paths.dotConfigPath,
      cmakeCachePath: paths.cmakeCachePath,
      buildInfoPath: paths.buildInfoPath,
      metaPath: paths.metaPath,
      statPath: paths.statPath,
    }));
  }
  if (wanted.has('kconfig')) {
    report.kconfig = attempt(report, 'kconfig', () => readZephyrKconfigReport({
      traceJsonPath: paths.traceJsonPath,
      dotConfigPath: paths.dotConfigPath,
      zephyrBase: report.summary?.target?.zephyrBase,
      westWorkspaceRoot: paths.westWorkspaceRoot,
    }));
  }
  if (wanted.has('deviceTree') && paths.dtsPath) {
    report.deviceTree = attempt(report, 'deviceTree', () => readZephyrDeviceTreeReport({
      dtsPath: paths.dtsPath as string,
      westWorkspaceRoot: paths.westWorkspaceRoot,
      appRootPath: paths.appRootPath,
    }));
  }
  if (wanted.has('elfStat')) {
    report.elfStat = attempt(report, 'elfStat', () => readZephyrStatFile(paths.statPath));
  }
  // The remaining sections need a linked binary.
  if (report.built && paths.elfPath) {
    if (wanted.has('memory')) {
      report.memory = attempt(report, 'memory', () => readZephyrMemoryReport(paths.elfPath as string));
    }
    if (wanted.has('memoryTree')) {
      report.memoryTree = attempt(report, 'memoryTree', () => readZephyrMemoryTreeReport({
        elfPath: paths.elfPath as string,
        zephyrBase: report.summary?.target?.zephyrBase,
      }));
    }
    if (wanted.has('sysInit')) {
      report.sysInit = attempt(report, 'sysInit', () => readZephyrSysInitReport({
        buildDir: paths.buildDir,
        elfPath: paths.elfPath as string,
        devicetreeHeaderPath: paths.devicetreeHeaderPath,
      }));
    }
  }
  return report;
}
