/**
 * Lean merger for the SPDX 2.x tag-value document set produced by Zephyr's
 * `west spdx` (app.spdx, zephyr.spdx, build.spdx, modules-deps.spdx, sdk.spdx).
 *
 * The verification service only evaluates package entries, so the merge keeps
 * package blocks and drops per-file inventory: the merged document is a few KB
 * instead of several MB and application source file names never leave the
 * machine. Cross-document references (DocumentRef-x:SPDXRef-y) are rewritten
 * to internal references when the target document is part of the merged set,
 * following the multi-document merge model of the SPDX 3 visualizer
 * (concatenate, unify by globally unique id, resolve imports, report
 * resolved/unresolved stats).
 *
 * The merger REFUSES (ok: false) instead of emitting a best-effort document
 * whenever the input does not look like the well-formed set the current zspdx
 * serializer guarantees (globally unique SPDXRef ids across the set).
 */

export interface MergeInputDoc {
  /** Base name of the source file, e.g. "zephyr.spdx" (used for stats and determinism). */
  fileName: string;
  content: string;
}

export interface MergeStats {
  documents: number;
  packagesKept: number;
  filesDropped: number;
  relationshipsKept: number;
  relationshipsDropped: number;
  crossDocRefsResolved: number;
  crossDocRefsDropped: number;
  licensesKept: number;
  licensesDeduped: number;
}

export type MergeOutcome =
  | { ok: true; content: string; stats: MergeStats }
  | { ok: false; reason: string };

interface ParsedPackage {
  spdxId: string;
  name: string;
  /** Package tag lines, already stripped of file inventory concerns. */
  lines: string[];
}

interface ParsedRelationship {
  from: string;
  type: string;
  to: string;
  raw: string;
}

interface ParsedDoc {
  fileName: string;
  spdxVersion: string;
  documentNamespace: string;
  created: string;
  /** DocumentRef-<name> -> referenced DocumentNamespace. */
  externalDocRefs: Map<string, string>;
  describesLines: string[];
  packages: ParsedPackage[];
  fileIds: Set<string>;
  fileCount: number;
  relationships: ParsedRelationship[];
  /** LicenseID value -> full block lines. */
  licenses: Map<string, string[]>;
}

const RELATIONSHIP_RE = /^Relationship:\s+(\S+)\s+(\S+)\s+(\S+)\s*$/;
const EXTERNAL_DOC_REF_RE = /^ExternalDocumentRef:\s+(DocumentRef-\S+)\s+(\S+)\s+SHA1:\s*\S+\s*$/;
const TAG_LINE_RE = /^([A-Za-z][A-Za-z0-9]*):/;

/** Restrict to the idstring charset SPDX allows (letters, digits, '.', '-'). */
function sanitizeSpdxName(name: string): string {
  return name.replace(/[^A-Za-z0-9.-]/g, '-');
}

function parseDoc(fileName: string, content: string): ParsedDoc | { error: string } {
  const fail = (message: string) => ({ error: `${fileName}: ${message}` });

  const lines = content.split(/\r?\n/);
  const doc: ParsedDoc = {
    fileName,
    spdxVersion: '',
    documentNamespace: '',
    created: '',
    externalDocRefs: new Map(),
    describesLines: [],
    packages: [],
    fileIds: new Set(),
    fileCount: 0,
    relationships: [],
    licenses: new Map(),
  };

  type Section = 'header' | 'package' | 'file' | 'license';
  let section: Section = 'header';
  let currentPackage: ParsedPackage | undefined;
  let currentLicenseLines: string[] | undefined;
  // Any tag value may span lines wrapped in <text>...</text> (zspdx emits this
  // for FileCopyrightText whenever REUSE finds a notice, and for license
  // ExtractedText). While a block is open, its lines go verbatim into textSink
  // (kept sections) or are discarded (dropped sections like file inventory).
  let inTextBlock = false;
  let textSink: string[] | undefined;

  const openTextBlockIfNeeded = (line: string, sink: string[] | undefined) => {
    if (line.includes('<text>') && !line.includes('</text>')) {
      inTextBlock = true;
      textSink = sink;
    }
  };

  const finishPackage = () => {
    if (currentPackage) {
      doc.packages.push(currentPackage);
      currentPackage = undefined;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (inTextBlock) {
      textSink?.push(line);
      if (line.includes('</text>')) {
        inTextBlock = false;
        textSink = undefined;
      }
      continue;
    }

    if (line.trim().length === 0) {
      continue;
    }

    // Package section marker comment written by zspdx; regenerated at emit time.
    if (line.startsWith('#')) {
      continue;
    }

    const relationshipMatch = line.match(RELATIONSHIP_RE);
    if (relationshipMatch) {
      const [, from, type, to] = relationshipMatch;
      if (from.startsWith('DocumentRef-')) {
        return fail(`unexpected cross-document reference on the left side of a relationship (${line})`);
      }
      const rel: ParsedRelationship = { from, type, to, raw: line };
      if (from === 'SPDXRef-DOCUMENT' && type === 'DESCRIBES') {
        doc.describesLines.push(line);
      } else {
        doc.relationships.push(rel);
      }
      continue;
    }

    const extRefMatch = line.match(EXTERNAL_DOC_REF_RE);
    if (extRefMatch) {
      doc.externalDocRefs.set(extRefMatch[1], extRefMatch[2]);
      continue;
    }

    if (line.startsWith('LicenseID:')) {
      section = 'license';
      finishPackage();
      const licenseId = line.slice('LicenseID:'.length).trim();
      currentLicenseLines = [line];
      doc.licenses.set(licenseId, currentLicenseLines);
      continue;
    }

    if (line.startsWith('PackageName:')) {
      finishPackage();
      section = 'package';
      currentPackage = {
        spdxId: '',
        name: line.slice('PackageName:'.length).trim(),
        lines: [line],
      };
      continue;
    }

    if (line.startsWith('FileName:')) {
      if (section !== 'package' && section !== 'file') {
        return fail(`file entry outside of a package (${line})`);
      }
      section = 'file';
      doc.fileCount += 1;
      continue;
    }

    if (!TAG_LINE_RE.test(line)) {
      return fail(`unrecognized line (${line.slice(0, 120)})`);
    }

    switch (section) {
      case 'header': {
        if (line.startsWith('SPDXVersion:')) {
          doc.spdxVersion = line.slice('SPDXVersion:'.length).trim();
        } else if (line.startsWith('DocumentNamespace:')) {
          doc.documentNamespace = line.slice('DocumentNamespace:'.length).trim();
        } else if (line.startsWith('Created:')) {
          doc.created = line.slice('Created:'.length).trim();
        }
        // Other header tags (DocumentName, Creator, DataLicense, SPDXID) are
        // replaced by the synthesized merged header.
        openTextBlockIfNeeded(line, undefined);
        break;
      }
      case 'package': {
        if (!currentPackage) {
          return fail(`package tag outside of a package (${line})`);
        }
        if (line.startsWith('SPDXID:')) {
          currentPackage.spdxId = line.slice('SPDXID:'.length).trim();
          currentPackage.lines.push(line);
          break;
        }
        // Lean merge: no per-file inventory, so the files-analyzed related
        // tags must be dropped or rewritten to stay spec-conformant.
        if (line.startsWith('PackageVerificationCode:') || line.startsWith('PackageLicenseInfoFromFiles:')) {
          break;
        }
        if (line.startsWith('FilesAnalyzed:')) {
          currentPackage.lines.push('FilesAnalyzed: false');
          break;
        }
        currentPackage.lines.push(line);
        openTextBlockIfNeeded(line, currentPackage.lines);
        break;
      }
      case 'file': {
        // Dropped entirely; only the file's SPDXID is remembered so that
        // relationships pointing at it can be filtered out.
        if (line.startsWith('SPDXID:')) {
          doc.fileIds.add(line.slice('SPDXID:'.length).trim());
        }
        openTextBlockIfNeeded(line, undefined);
        break;
      }
      case 'license': {
        currentLicenseLines?.push(line);
        openTextBlockIfNeeded(line, currentLicenseLines);
        break;
      }
    }
  }

  if (inTextBlock) {
    return fail('unterminated <text> block');
  }
  finishPackage();

  if (!/^SPDX-2\.[23]$/.test(doc.spdxVersion)) {
    return fail(`unsupported or missing SPDXVersion (${doc.spdxVersion || 'none'})`);
  }
  if (!doc.documentNamespace) {
    return fail('missing DocumentNamespace');
  }
  if (!doc.created) {
    return fail('missing Created timestamp');
  }
  for (const pkg of doc.packages) {
    if (!pkg.spdxId) {
      return fail(`package without SPDXID (${pkg.name})`);
    }
  }

  return doc;
}

export function mergeSpdxSet(
  inputDocs: MergeInputDoc[],
  options: { documentName: string },
): MergeOutcome {
  if (inputDocs.length === 0) {
    return { ok: false, reason: 'no SPDX documents to merge' };
  }

  // Stable order regardless of directory enumeration, for deterministic bytes.
  const sortedInputs = [...inputDocs].sort((a, b) => a.fileName.localeCompare(b.fileName));

  const docs: ParsedDoc[] = [];
  for (const input of sortedInputs) {
    const parsed = parseDoc(input.fileName, input.content);
    if ('error' in parsed) {
      return { ok: false, reason: parsed.error };
    }
    docs.push(parsed);
  }

  const spdxVersion = docs[0].spdxVersion;
  if (docs.some(doc => doc.spdxVersion !== spdxVersion)) {
    return { ok: false, reason: 'documents use different SPDX versions' };
  }
  if (docs.every(doc => doc.packages.length === 0)) {
    return { ok: false, reason: 'no packages found in the document set' };
  }

  // Globally unique ids are guaranteed by the current zspdx serializer; a
  // collision means an older generator wrote this set, so refuse.
  const packageIds = new Set<string>();
  const allFileIds = new Set<string>();
  const namespaceToDoc = new Map<string, ParsedDoc>();
  for (const doc of docs) {
    for (const pkg of doc.packages) {
      if (packageIds.has(pkg.spdxId)) {
        return { ok: false, reason: `duplicate SPDXID across documents (${pkg.spdxId})` };
      }
      packageIds.add(pkg.spdxId);
    }
    for (const fileId of doc.fileIds) {
      allFileIds.add(fileId);
    }
    namespaceToDoc.set(doc.documentNamespace, doc);
  }
  for (const fileId of allFileIds) {
    if (packageIds.has(fileId)) {
      return { ok: false, reason: `duplicate SPDXID across documents (${fileId})` };
    }
  }

  const stats: MergeStats = {
    documents: docs.length,
    packagesKept: packageIds.size,
    filesDropped: docs.reduce((sum, doc) => sum + doc.fileCount, 0),
    relationshipsKept: 0,
    relationshipsDropped: 0,
    crossDocRefsResolved: 0,
    crossDocRefsDropped: 0,
    licensesKept: 0,
    licensesDeduped: 0,
  };

  // Resolve and filter relationships. Only package-to-package edges survive:
  // per-file inventory is dropped, so relationships touching file ids go too.
  const keptRelationships: string[] = [];
  const seenRelationships = new Set<string>();
  for (const doc of docs) {
    for (const rel of doc.relationships) {
      let target = rel.to;
      const crossDocMatch = target.match(/^(DocumentRef-[^:]+):(\S+)$/);
      if (crossDocMatch) {
        const refNamespace = doc.externalDocRefs.get(crossDocMatch[1]);
        const targetDoc = refNamespace ? namespaceToDoc.get(refNamespace) : undefined;
        if (!targetDoc) {
          // Referenced document is not part of the merged set (e.g. sdk.spdx
          // excluded): the edge cannot be represented, drop it.
          stats.crossDocRefsDropped += 1;
          stats.relationshipsDropped += 1;
          continue;
        }
        stats.crossDocRefsResolved += 1;
        target = crossDocMatch[2];
      }

      const fromKnown = rel.from === 'SPDXRef-DOCUMENT' || packageIds.has(rel.from);
      const toKnown = packageIds.has(target);
      if (!fromKnown || !toKnown) {
        stats.relationshipsDropped += 1;
        continue;
      }
      const line = `Relationship: ${rel.from} ${rel.type} ${target}`;
      if (!seenRelationships.has(line)) {
        seenRelationships.add(line);
        keptRelationships.push(line);
        stats.relationshipsKept += 1;
      }
    }
  }

  // Union of custom licenses, deduplicated by LicenseID.
  const licenses = new Map<string, string[]>();
  for (const doc of docs) {
    for (const [licenseId, blockLines] of doc.licenses) {
      if (licenses.has(licenseId)) {
        stats.licensesDeduped += 1;
      } else {
        licenses.set(licenseId, blockLines);
      }
    }
  }
  stats.licensesKept = licenses.size;

  // Deterministic header: reuse source facts (latest Created, first namespace)
  // so an unchanged document set merges to byte-identical output and the
  // service-side sha256 cache probe hits.
  const created = docs.map(doc => doc.created).sort().pop() as string;
  const namespace = `${docs[0].documentNamespace}-merged`;

  const out: string[] = [];
  out.push(`SPDXVersion: ${spdxVersion}`);
  out.push('DataLicense: CC0-1.0');
  out.push('SPDXID: SPDXRef-DOCUMENT');
  out.push(`DocumentName: ${sanitizeSpdxName(options.documentName)}`);
  out.push(`DocumentNamespace: ${namespace}`);
  out.push('Creator: Tool: Zephyr Workbench SBOM merger');
  out.push(`Created: ${created}`);
  out.push('');

  const seenDescribes = new Set<string>();
  for (const doc of docs) {
    for (const line of doc.describesLines) {
      if (!seenDescribes.has(line)) {
        seenDescribes.add(line);
        out.push(line);
      }
    }
  }
  if (seenDescribes.size > 0) {
    out.push('');
  }

  for (const doc of docs) {
    for (const pkg of doc.packages) {
      out.push(`##### Package: ${sanitizeSpdxName(pkg.name)}`);
      out.push('');
      out.push(...pkg.lines);
      out.push('');
    }
  }

  if (keptRelationships.length > 0) {
    out.push(...keptRelationships);
    out.push('');
  }

  for (const blockLines of licenses.values()) {
    out.push(...blockLines);
  }

  return { ok: true, content: `${out.join('\n')}\n`, stats };
}

export interface MergeSpdx3Stats {
  documents: number;
  elementsKept: number;
  duplicatesDropped: number;
}

export type MergeSpdx3Outcome =
  | { ok: true; content: string; stats: MergeSpdx3Stats }
  | { ok: false; reason: string };

/**
 * Merge an SPDX 3.0 JSON-LD document set into a single document: concatenate
 * every file's @graph and dedupe elements by their globally unique spdxId IRI
 * (first occurrence wins), keeping the first document's @context. This is the
 * multi-document model used by the SPDX 3 visualizer; SPDX 3 ids are IRIs, so
 * cross-document references unify by identity once the sets are combined.
 */
export function mergeSpdx3Set(inputDocs: MergeInputDoc[]): MergeSpdx3Outcome {
  if (inputDocs.length === 0) {
    return { ok: false, reason: 'no SPDX 3.0 documents to merge' };
  }
  const sortedInputs = [...inputDocs].sort((a, b) => a.fileName.localeCompare(b.fileName));

  let context: unknown;
  const elements: unknown[] = [];
  const seenIds = new Set<string>();
  let duplicatesDropped = 0;

  for (const input of sortedInputs) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(input.content) as Record<string, unknown>;
    } catch (error) {
      return { ok: false, reason: `${input.fileName}: invalid JSON (${error instanceof Error ? error.message : error})` };
    }
    const graph = data['@graph'];
    if (!data['@context'] || !Array.isArray(graph)) {
      return { ok: false, reason: `${input.fileName}: not an SPDX 3.0 JSON-LD document (missing @context or @graph)` };
    }
    context = context ?? data['@context'];
    for (const element of graph) {
      const id =
        element && typeof element === 'object'
          ? ((element as Record<string, unknown>).spdxId ?? (element as Record<string, unknown>)['@id'])
          : undefined;
      if (typeof id === 'string') {
        if (seenIds.has(id)) {
          duplicatesDropped += 1;
          continue;
        }
        seenIds.add(id);
      }
      elements.push(element);
    }
  }

  return {
    ok: true,
    content: JSON.stringify({ '@context': context, '@graph': elements }, undefined, 1),
    stats: {
      documents: sortedInputs.length,
      elementsKept: elements.length,
      duplicatesDropped,
    },
  };
}

/**
 * Preferred single-file fallback order when the set cannot be merged:
 * modules-deps carries the real package identifiers (PURL/CPE/versions),
 * zephyr at least the Zephyr CPE, build has no scannable identifiers.
 */
export function pickFallbackFile(fileNames: string[]): string | undefined {
  const preference = ['modules-deps.spdx', 'zephyr.spdx', 'build.spdx', 'app.spdx'];
  for (const name of preference) {
    if (fileNames.includes(name)) {
      return name;
    }
  }
  return fileNames.length > 0 ? [...fileNames].sort()[0] : undefined;
}
