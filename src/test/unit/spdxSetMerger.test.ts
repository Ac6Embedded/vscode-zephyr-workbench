import { strict as assert } from 'assert';

import { mergeSpdx3Set, mergeSpdxSet, pickFallbackFile } from '../../sbomtotal/spdxSetMerger';

// Fixtures modeled on the exact tag-value grammar of Zephyr's zspdx
// SPDX 2 serializer (header, ExternalDocumentRef, DESCRIBES, package blocks
// with file inventory and interleaved relationships, custom license blocks).

const ZEPHYR_DOC = `SPDXVersion: SPDX-2.3
DataLicense: CC0-1.0
SPDXID: SPDXRef-DOCUMENT
DocumentName: zephyr-sources
DocumentNamespace: http://example.com/proj/zephyr
Creator: Tool: Zephyr SPDX builder
Created: 2026-07-10T10:00:00Z

Relationship: SPDXRef-DOCUMENT DESCRIBES SPDXRef-zephyr-sources

##### Package: zephyr-sources

PackageName: zephyr-sources
SPDXID: SPDXRef-zephyr-sources
PackageLicenseConcluded: NOASSERTION
PackageLicenseDeclared: NOASSERTION
PackageCopyrightText: NOASSERTION
PackageDownloadLocation: NOASSERTION
PackageVersion: v4.1.0
ExternalRef: SECURITY cpe23Type cpe:2.3:o:zephyrproject:zephyr:4.1.0:*:*:*:*:*:*:*
PackageLicenseInfoFromFiles: Apache-2.0
FilesAnalyzed: true
PackageVerificationCode: 0123456789abcdef0123456789abcdef01234567

FileName: ./kernel/main.c
SPDXID: SPDXRef-File-main.c
FileChecksum: SHA1: da39a3ee5e6b4b0d3255bfef95601890afd80709
LicenseConcluded: Apache-2.0
LicenseInfoInFile: Apache-2.0
FileCopyrightText: <text>
 * Copyright (c) 2016 Intel Corporation
</text>

Relationship: SPDXRef-File-main.c GENERATED_FROM SPDXRef-zephyr-sources

LicenseID: LicenseRef-Zephyr-custom
ExtractedText: LicenseRef-Zephyr-custom
LicenseName: LicenseRef-Zephyr-custom
LicenseComment: Corresponds to the license ID \`LicenseRef-Zephyr-custom\` detected in an SPDX-License-Identifier: tag.
`;

const BUILD_DOC = `SPDXVersion: SPDX-2.3
DataLicense: CC0-1.0
SPDXID: SPDXRef-DOCUMENT
DocumentName: build
DocumentNamespace: http://example.com/proj/build
Creator: Tool: Zephyr SPDX builder
Created: 2026-07-10T10:05:00Z

ExternalDocumentRef: DocumentRef-zephyr http://example.com/proj/zephyr SHA1: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
ExternalDocumentRef: DocumentRef-sdk http://example.com/proj/sdk SHA1: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

Relationship: SPDXRef-DOCUMENT DESCRIBES SPDXRef-zephyr-final

##### Package: zephyr-final

PackageName: zephyr_final
SPDXID: SPDXRef-zephyr-final
PackageLicenseConcluded: NOASSERTION
PackageLicenseDeclared: NOASSERTION
PackageCopyrightText: NOASSERTION
PackageDownloadLocation: NOASSERTION
FilesAnalyzed: false
PackageComment: Utility target; no files

Relationship: SPDXRef-zephyr-final GENERATED_FROM DocumentRef-zephyr:SPDXRef-zephyr-sources
Relationship: SPDXRef-zephyr-final GENERATED_FROM DocumentRef-zephyr:SPDXRef-File-main.c
Relationship: SPDXRef-zephyr-final GENERATED_FROM DocumentRef-sdk:SPDXRef-sdk-sources
`;

const MODULES_DEPS_DOC = `SPDXVersion: SPDX-2.3
DataLicense: CC0-1.0
SPDXID: SPDXRef-DOCUMENT
DocumentName: modules-deps
DocumentNamespace: http://example.com/proj/modules-deps
Creator: Tool: Zephyr SPDX builder
Created: 2026-07-10T10:04:00Z

ExternalDocumentRef: DocumentRef-zephyr http://example.com/proj/zephyr SHA1: cccccccccccccccccccccccccccccccccccccccc

Relationship: SPDXRef-DOCUMENT DESCRIBES SPDXRef-zephyr-deps

##### Package: zephyr-deps

PackageName: zephyr-deps
SPDXID: SPDXRef-zephyr-deps
PackageLicenseConcluded: NOASSERTION
PackageLicenseDeclared: NOASSERTION
PackageCopyrightText: NOASSERTION
PackageDownloadLocation: NOASSERTION
PackageVersion: v4.1.0
ExternalRef: PACKAGE-MANAGER purl pkg:github/zephyrproject-rtos/zephyr@v4.1.0
FilesAnalyzed: false
PackageComment: Utility target; no files

Relationship: SPDXRef-zephyr-deps DEPENDS_ON DocumentRef-zephyr:SPDXRef-zephyr-sources
`;

describe('spdxSetMerger', () => {
	it('merges a document set into one packages-only document', () => {
		const outcome = mergeSpdxSet(
			[
				{ fileName: 'zephyr.spdx', content: ZEPHYR_DOC },
				{ fileName: 'build.spdx', content: BUILD_DOC },
				{ fileName: 'modules-deps.spdx', content: MODULES_DEPS_DOC },
			],
			{ documentName: 'app-primary-sbom' },
		);

		assert.equal(outcome.ok, true);
		if (!outcome.ok) { return; }

		const { content, stats } = outcome;
		// One synthesized header.
		assert.equal((content.match(/SPDXVersion:/g) ?? []).length, 1);
		assert.match(content, /DocumentName: app-primary-sbom/);
		// Latest source Created reused (determinism).
		assert.match(content, /Created: 2026-07-10T10:05:00Z/);
		// All three packages kept, with identifiers intact.
		assert.match(content, /SPDXID: SPDXRef-zephyr-sources/);
		assert.match(content, /SPDXID: SPDXRef-zephyr-final/);
		assert.match(content, /ExternalRef: PACKAGE-MANAGER purl pkg:github\/zephyrproject-rtos\/zephyr@v4\.1\.0/);
		assert.match(content, /ExternalRef: SECURITY cpe23Type/);
		// File inventory dropped and files-analyzed tags rewritten. The
		// multi-line FileCopyrightText <text> block (real zspdx output shape)
		// must be swallowed with the file, not break parsing.
		assert.doesNotMatch(content, /FileName:/);
		assert.doesNotMatch(content, /Intel Corporation/);
		assert.doesNotMatch(content, /PackageVerificationCode:/);
		assert.doesNotMatch(content, /PackageLicenseInfoFromFiles:/);
		assert.doesNotMatch(content, /FilesAnalyzed: true/);
		// Cross-document package reference rewritten to an internal one.
		assert.match(content, /Relationship: SPDXRef-zephyr-final GENERATED_FROM SPDXRef-zephyr-sources/);
		assert.match(content, /Relationship: SPDXRef-zephyr-deps DEPENDS_ON SPDXRef-zephyr-sources/);
		// References to a dropped file and to a document outside the set are gone.
		assert.doesNotMatch(content, /SPDXRef-File-main\.c/);
		assert.doesNotMatch(content, /DocumentRef-/);
		// Both DESCRIBES lines survive.
		assert.match(content, /Relationship: SPDXRef-DOCUMENT DESCRIBES SPDXRef-zephyr-final/);
		assert.match(content, /Relationship: SPDXRef-DOCUMENT DESCRIBES SPDXRef-zephyr-deps/);
		// Custom license block kept.
		assert.match(content, /LicenseID: LicenseRef-Zephyr-custom/);

		assert.equal(stats.documents, 3);
		assert.equal(stats.packagesKept, 3);
		assert.equal(stats.filesDropped, 1);
		assert.equal(stats.crossDocRefsResolved, 3);
		// DocumentRef-sdk points outside the merged set.
		assert.equal(stats.crossDocRefsDropped, 1);
		// zephyr-final -> File-main.c resolved but the file was dropped, and the
		// file-level relationship (from a dropped file id) goes too.
		assert.equal(stats.relationshipsKept, 2);
		assert.equal(stats.relationshipsDropped, 3);
		assert.equal(stats.licensesKept, 1);
	});

	it('is deterministic regardless of input order', () => {
		const docs = [
			{ fileName: 'zephyr.spdx', content: ZEPHYR_DOC },
			{ fileName: 'build.spdx', content: BUILD_DOC },
			{ fileName: 'modules-deps.spdx', content: MODULES_DEPS_DOC },
		];
		const a = mergeSpdxSet(docs, { documentName: 'x' });
		const b = mergeSpdxSet([...docs].reverse(), { documentName: 'x' });
		assert.equal(a.ok, true);
		assert.equal(b.ok, true);
		if (a.ok && b.ok) {
			assert.equal(a.content, b.content);
		}
	});

	it('refuses on duplicate SPDXIDs across documents', () => {
		const clone = ZEPHYR_DOC.replace('DocumentNamespace: http://example.com/proj/zephyr', 'DocumentNamespace: http://example.com/proj/zephyr2');
		const outcome = mergeSpdxSet(
			[
				{ fileName: 'zephyr.spdx', content: ZEPHYR_DOC },
				{ fileName: 'zephyr2.spdx', content: clone },
			],
			{ documentName: 'x' },
		);
		assert.equal(outcome.ok, false);
		if (!outcome.ok) {
			assert.match(outcome.reason, /duplicate SPDXID/);
		}
	});

	it('refuses on documents that are not SPDX 2.x tag-value', () => {
		const spdx3 = '{"@context": "https://spdx.org/rdf/3.0.1/spdx-context.jsonld", "@graph": []}';
		const outcome = mergeSpdxSet(
			[{ fileName: 'app.jsonld', content: spdx3 }],
			{ documentName: 'x' },
		);
		assert.equal(outcome.ok, false);
	});

	it('refuses on a package without SPDXID', () => {
		const broken = ZEPHYR_DOC.replace('SPDXID: SPDXRef-zephyr-sources\n', '');
		const outcome = mergeSpdxSet(
			[{ fileName: 'zephyr.spdx', content: broken }],
			{ documentName: 'x' },
		);
		assert.equal(outcome.ok, false);
		if (!outcome.ok) {
			assert.match(outcome.reason, /without SPDXID/);
		}
	});

	it('resolves cross-document DESCRIBES targets and drops unresolvable ones', () => {
		// A build-style doc that DESCRIBES a package living in another document,
		// plus one DESCRIBES pointing at a document outside the merged set.
		const describerDoc = BUILD_DOC.replace(
			'Relationship: SPDXRef-DOCUMENT DESCRIBES SPDXRef-zephyr-final',
			'Relationship: SPDXRef-DOCUMENT DESCRIBES SPDXRef-zephyr-final\nRelationship: SPDXRef-DOCUMENT DESCRIBES DocumentRef-zephyr:SPDXRef-zephyr-sources\nRelationship: SPDXRef-DOCUMENT DESCRIBES DocumentRef-sdk:SPDXRef-sdk-sources',
		);
		const outcome = mergeSpdxSet(
			[
				{ fileName: 'zephyr.spdx', content: ZEPHYR_DOC },
				{ fileName: 'build.spdx', content: describerDoc },
			],
			{ documentName: 'x' },
		);
		assert.equal(outcome.ok, true);
		if (!outcome.ok) { return; }
		// Cross-doc target inside the set: rewritten to an internal reference.
		assert.match(outcome.content, /Relationship: SPDXRef-DOCUMENT DESCRIBES SPDXRef-zephyr-sources/);
		// Cross-doc target outside the set: dropped, never emitted verbatim.
		assert.doesNotMatch(outcome.content, /DESCRIBES DocumentRef-/);
	});

	it('keeps multi-line text values inside package blocks verbatim', () => {
		const doc = ZEPHYR_DOC.replace(
			'PackageCopyrightText: NOASSERTION',
			'PackageCopyrightText: <text>\nCopyright (c) 2024 Example Corp\n</text>',
		);
		const outcome = mergeSpdxSet([{ fileName: 'zephyr.spdx', content: doc }], { documentName: 'x' });
		assert.equal(outcome.ok, true);
		if (outcome.ok) {
			assert.match(outcome.content, /PackageCopyrightText: <text>\nCopyright \(c\) 2024 Example Corp\n<\/text>/);
		}
	});

	it('picks the most meaningful fallback file', () => {
		assert.equal(
			pickFallbackFile(['app.spdx', 'build.spdx', 'modules-deps.spdx', 'zephyr.spdx']),
			'modules-deps.spdx',
		);
		assert.equal(pickFallbackFile(['app.spdx', 'build.spdx', 'zephyr.spdx']), 'zephyr.spdx');
		assert.equal(pickFallbackFile(['app.spdx', 'build.spdx']), 'build.spdx');
		assert.equal(pickFallbackFile(['custom.spdx']), 'custom.spdx');
		assert.equal(pickFallbackFile([]), undefined);
	});

	describe('mergeSpdx3Set', () => {
		const DOC_A = JSON.stringify({
			'@context': 'https://spdx.org/rdf/3.0.1/spdx-context.jsonld',
			'@graph': [
				{ type: 'SpdxDocument', spdxId: 'https://example.com/doc-a' },
				{ type: 'software_Package', spdxId: 'https://example.com/pkg-zephyr', name: 'zephyr' },
			],
		});
		const DOC_B = JSON.stringify({
			'@context': 'https://spdx.org/rdf/3.0.1/spdx-context.jsonld',
			'@graph': [
				{ type: 'SpdxDocument', spdxId: 'https://example.com/doc-b' },
				// Same IRI as in DOC_A: must be deduped (first occurrence wins).
				{ type: 'software_Package', spdxId: 'https://example.com/pkg-zephyr', name: 'zephyr' },
				{ type: 'software_Package', spdxId: 'https://example.com/pkg-mbedtls', name: 'mbedtls' },
			],
		});

		it('concatenates graphs and dedupes elements by spdxId', () => {
			const outcome = mergeSpdx3Set([
				{ fileName: 'zephyr.jsonld', content: DOC_A },
				{ fileName: 'build.jsonld', content: DOC_B },
			]);
			assert.equal(outcome.ok, true);
			if (!outcome.ok) { return; }
			assert.equal(outcome.stats.documents, 2);
			assert.equal(outcome.stats.elementsKept, 4);
			assert.equal(outcome.stats.duplicatesDropped, 1);
			const parsed = JSON.parse(outcome.content) as { '@graph': unknown[] };
			assert.equal(parsed['@graph'].length, 4);
		});

		it('is deterministic regardless of input order', () => {
			const docs = [
				{ fileName: 'zephyr.jsonld', content: DOC_A },
				{ fileName: 'build.jsonld', content: DOC_B },
			];
			const a = mergeSpdx3Set(docs);
			const b = mergeSpdx3Set([...docs].reverse());
			assert.equal(a.ok, true);
			assert.equal(b.ok, true);
			if (a.ok && b.ok) {
				assert.equal(a.content, b.content);
			}
		});

		it('refuses non-JSON-LD input', () => {
			assert.equal(mergeSpdx3Set([{ fileName: 'x.jsonld', content: 'SPDXVersion: SPDX-2.3' }]).ok, false);
			assert.equal(mergeSpdx3Set([{ fileName: 'x.jsonld', content: '{"spdxVersion": "SPDX-2.3"}' }]).ok, false);
			assert.equal(mergeSpdx3Set([]).ok, false);
		});
	});
});
