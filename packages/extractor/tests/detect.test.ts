import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { detectFormat } from '../src/detect.js';

const enc = new TextEncoder();

async function zipWith(paths: string[]): Promise<Uint8Array> {
	const zip = new JSZip();
	for (const p of paths) zip.file(p, 'x');
	return zip.generateAsync({ type: 'uint8array' });
}

describe('detectFormat', () => {
	it('detects PDF by magic bytes', async () => {
		const data = enc.encode('%PDF-1.4 fake body');
		expect(await detectFormat(data, 'file.bin')).toBe('pdf');
	});

	it('detects docx/xlsx/pptx by OOXML top-level directory', async () => {
		expect(await detectFormat(await zipWith(['word/document.xml']), 'f.bin')).toBe('docx');
		expect(await detectFormat(await zipWith(['xl/workbook.xml']), 'f.bin')).toBe('xlsx');
		expect(await detectFormat(await zipWith(['ppt/presentation.xml']), 'f.bin')).toBe('pptx');
	});

	it('falls back to plain text for UTF-8 without NUL bytes', async () => {
		expect(await detectFormat(enc.encode('just some text'), 'file.unknownext')).toBe('text');
	});

	it('returns undefined for binary data that matches nothing', async () => {
		const data = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]);
		expect(await detectFormat(data, 'file.bin')).toBeUndefined();
	});

	it('mime type wins over extension', async () => {
		const data = enc.encode('{"a":1}');
		expect(await detectFormat(data, 'data.txt', 'application/json')).toBe('json');
	});

	it('strips mime parameters before lookup', async () => {
		const data = enc.encode('hello');
		expect(await detectFormat(data, 'x.unknownext', 'text/plain; charset=utf-8')).toBe('text');
	});

	it('re-verifies claimed binary formats against actual bytes (mislabeled file)', async () => {
		// Claimed as pdf by extension, but bytes are plain text ⇒ resolved by real bytes
		const data = enc.encode('definitely not a pdf');
		expect(await detectFormat(data, 'fake.pdf')).toBe('text');
	});

	it('keeps the claimed binary format when bytes are unidentifiable', async () => {
		// Claimed docx; bytes are not a zip and not UTF-8 text ⇒ fall back to the claim
		const data = new Uint8Array([0xff, 0xd8, 0x00, 0x01]);
		expect(await detectFormat(data, 'file.docx')).toBe('docx');
	});

	it('maps text-family extensions', async () => {
		const text = enc.encode('content');
		expect(await detectFormat(text, 'a.md')).toBe('markdown');
		expect(await detectFormat(text, 'a.csv')).toBe('csv');
		expect(await detectFormat(text, 'a.html')).toBe('html');
		expect(await detectFormat(text, 'a.log')).toBe('text');
	});
});
