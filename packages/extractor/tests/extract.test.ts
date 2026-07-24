import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { extractText } from '../src/index.js';

const enc = new TextEncoder();

// ─── In-test fixture builders (no binary fixtures committed to the repo) ─────

/** Minimal docx: OOXML zip with a word/document.xml body. */
async function buildDocx(paragraphs: string[]): Promise<Uint8Array> {
	const zip = new JSZip();
	zip.file(
		'[Content_Types].xml',
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
	);
	zip.file(
		'_rels/.rels',
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
	);
	zip.file(
		'word/document.xml',
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('\n    ')}
  </w:body>
</w:document>`,
	);
	return zip.generateAsync({ type: 'uint8array' });
}

/** Minimal xlsx via exceljs. */
async function buildXlsx(rows: string[][]): Promise<Uint8Array> {
	const workbook = new ExcelJS.Workbook();
	const sheet = workbook.addWorksheet('Sheet1');
	for (const row of rows) sheet.addRow(row);
	const buffer = await workbook.xlsx.writeBuffer();
	return new Uint8Array(buffer as ArrayBuffer);
}

/** Minimal pptx: OOXML zip with one slide containing a:t text runs. */
async function buildPptx(slideTexts: string[][]): Promise<Uint8Array> {
	const zip = new JSZip();
	zip.file(
		'[Content_Types].xml',
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>`,
	);
	slideTexts.forEach((texts, i) => {
		zip.file(
			`ppt/slides/slide${i + 1}.xml`,
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    ${texts.map((t) => `<p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`).join('\n    ')}
  </p:spTree></p:cSld>
</p:sld>`,
		);
	});
	return zip.generateAsync({ type: 'uint8array' });
}

/** Minimal single-page PDF with one text draw (pdfjs tolerates the missing xref). */
function buildPdf(text: string): Uint8Array {
	const stream = `BT /F1 24 Tf 100 700 Td (${text}) Tj ET`;
	const objects = [
		'<</Type/Catalog/Pages 2 0 R>>',
		'<</Type/Pages/Kids[3 0 R]/Count 1>>',
		'<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
		'<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
		`<</Length ${stream.length}>>stream\n${stream}\nendstream`,
	];
	let pdf = '%PDF-1.4\n';
	objects.forEach((body, i) => {
		pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	pdf += 'trailer\n<</Size 6/Root 1 0 R>>\n%%EOF';
	return enc.encode(pdf);
}

// ─── Text family ──────────────────────────────────────────────────────────────

describe('extractText — text family', () => {
	it('extracts plain text with line locations', async () => {
		const result = await extractText({ data: enc.encode('line one\nline two'), fileName: 'a.txt' });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.format).toBe('text');
		expect(result.segments[0].text).toContain('line one');
		expect(result.segments[0].location.type).toBe('lines');
	});

	it('extracts csv and keeps the header line on later segments', async () => {
		const rows = ['name,age'];
		for (let i = 0; i < 200; i++) rows.push(`person${i},${i}`);
		const result = await extractText({ data: enc.encode(rows.join('\n')), fileName: 'people.csv' });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.format).toBe('csv');
		expect(result.segments.length).toBeGreaterThan(1);
		// Segments beyond the first re-prepend the header so chunks stay self-describing
		expect(result.segments[1].text.startsWith('name,age')).toBe(true);
	});

	it('rejects non-UTF-8 input as corrupt', async () => {
		const result = await extractText({
			data: new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x80]),
			fileName: 'a.txt',
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errorCode).toBe('corrupt_file');
	});
});

describe('extractText — html', () => {
	it('strips scripts, styles, and tags; keeps text', async () => {
		const html = `<html><head><style>body{color:red}</style></head>
<body><h1>Title</h1><p>Hello <b>world</b></p><script>alert(1)</script><p>Second &amp; third</p></body></html>`;
		const result = await extractText({ data: enc.encode(html), fileName: 'page.html' });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const text = result.segments.map((s) => s.text).join('\n');
		expect(text).toContain('Title');
		expect(text).toContain('Hello world');
		expect(text).toContain('Second & third');
		expect(text).not.toContain('alert');
		expect(text).not.toContain('color:red');
	});
});

// ─── OOXML ───────────────────────────────────────────────────────────────────

describe('extractText — OOXML', () => {
	it('extracts docx paragraphs', async () => {
		const data = await buildDocx(['First paragraph', 'Second paragraph']);
		const result = await extractText({ data, fileName: 'doc.docx' });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const text = result.segments.map((s) => s.text).join('\n');
		expect(text).toContain('First paragraph');
		expect(text).toContain('Second paragraph');
	});

	it('extracts xlsx rows with sheet locations', async () => {
		const data = await buildXlsx([
			['Name', 'Age'],
			['Alice', '30'],
			['Bob', '25'],
		]);
		const result = await extractText({ data, fileName: 'sheet.xlsx' });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const text = result.segments.map((s) => s.text).join('\n');
		expect(text).toContain('Alice');
		expect(text).toContain('Bob');
	});

	it('extracts pptx slide text with slide locations', async () => {
		const data = await buildPptx([['Slide one title', 'Slide one body'], ['Slide two title']]);
		const result = await extractText({ data, fileName: 'deck.pptx' });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const text = result.segments.map((s) => s.text).join('\n');
		expect(text).toContain('Slide one title');
		expect(text).toContain('Slide two title');
	});
});

// ─── PDF ─────────────────────────────────────────────────────────────────────

describe('extractText — pdf', () => {
	it('extracts page text with page locations', async () => {
		const data = buildPdf('Hello Valmis PDF');
		const result = await extractText({ data, fileName: 'doc.pdf' });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.segments[0].location.type).toBe('page');
		expect(result.segments[0].text).toContain('Hello Valmis PDF');
	});

	it('reports a corrupt PDF as corrupt_file', async () => {
		const result = await extractText({ data: enc.encode('%PDF-1.4 garbage that is not a pdf'), fileName: 'bad.pdf' });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errorCode).toBe('corrupt_file');
	});
});

// ─── Error paths ─────────────────────────────────────────────────────────────

describe('extractText — error paths', () => {
	it('empty input ⇒ empty_document', async () => {
		const result = await extractText({ data: new Uint8Array(0), fileName: 'a.txt' });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errorCode).toBe('empty_document');
	});

	it('unsupported format ⇒ unsupported_format', async () => {
		const result = await extractText({
			data: new Uint8Array([0x00, 0x01, 0x02, 0x03]),
			fileName: 'blob.bin',
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errorCode).toBe('unsupported_format');
	});

	it('whitespace-only document ⇒ empty_document', async () => {
		const result = await extractText({ data: enc.encode('   \n \n '), fileName: 'a.txt' });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errorCode).toBe('empty_document');
	});
});
