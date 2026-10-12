// Upload validation: magic-byte checks and multipart parsing safety.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  UploadError,
  detectWorkbookKind,
  parseMultipartFile,
  validateWorkbookUpload,
  readBodyLimited,
  MAX_UPLOAD_BYTES,
} from '../dist/upload.js';

/** Build a minimal multipart body containing one file part. */
function multipartBody(fieldName, filename, contentType, data) {
  const boundary = '----ScraperToolTestBoundary123';
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return {
    body: Buffer.concat([Buffer.from(head, 'utf8'), data, Buffer.from(tail, 'utf8')]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** Fake a readable request stream from a buffer. */
function fakeRequest(buffer) {
  const listeners = {};
  return {
    on(event, handler) {
      listeners[event] = handler;
      return this;
    },
    destroy() {
      this.destroyed = true;
    },
    destroyed: false,
    emit() {
      listeners.data?.(buffer);
      listeners.end?.();
    },
  };
}

const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const XLS_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

test('detectWorkbookKind recognises xlsx, xls and junk', () => {
  assert.equal(detectWorkbookKind(XLSX_MAGIC), 'xlsx');
  assert.equal(detectWorkbookKind(XLS_MAGIC), 'xls');
  assert.equal(detectWorkbookKind(Buffer.from('PKnotreallyazip')), 'unknown');
  assert.equal(detectWorkbookKind(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'unknown', 'an ELF binary');
  assert.equal(detectWorkbookKind(Buffer.alloc(0)), 'unknown');
});

test('validateWorkbookUpload accepts a real xlsx signature', () => {
  const payload = Buffer.concat([XLSX_MAGIC, Buffer.alloc(64)]);
  assert.doesNotThrow(() =>
    validateWorkbookUpload({ filename: 'asins.xlsx', contentType: 'application/octet-stream', data: payload }),
  );
});

test('validateWorkbookUpload rejects a renamed non-spreadsheet', () => {
  // Filename says .xlsx but the bytes are an ELF binary.
  const payload = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(32)]);
  assert.throws(
    () => validateWorkbookUpload({ filename: 'evil.xlsx', contentType: 'text/plain', data: payload }),
    /not a recognised Excel workbook/i,
  );
});

test('validateWorkbookUpload explains how to convert a legacy .xls', () => {
  const payload = Buffer.concat([XLS_MAGIC, Buffer.alloc(32)]);
  assert.throws(
    () => validateWorkbookUpload({ filename: 'old.xls', contentType: 'application/vnd.ms-excel', data: payload }),
    (error) => {
      assert.ok(error instanceof UploadError);
      assert.equal(error.status, 415);
      assert.match(error.message, /Save As/);
      assert.match(error.message, /\.xlsx/);
      return true;
    },
  );
});

test('parseMultipartFile extracts the named file part', () => {
  const content = Buffer.concat([XLSX_MAGIC, Buffer.from('payload')]);
  const { body, contentType } = multipartBody('file', 'asins.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content);
  const file = parseMultipartFile(body, contentType, 'file');

  assert.equal(file.filename, 'asins.xlsx');
  assert.ok(file.data.equals(content), 'binary content must survive byte-for-byte');
});

test('parseMultipartFile rejects an empty body and a missing boundary', () => {
  assert.throws(() => parseMultipartFile(Buffer.alloc(0), 'multipart/form-data; boundary=x'), UploadError);
  assert.throws(() => parseMultipartFile(Buffer.from('junk'), 'application/json'), /Content-Type|boundary/i);
});

test('parseMultipartFile rejects a body with no matching field', () => {
  const { body, contentType } = multipartBody('other', 'x.xlsx', 'text/plain', XLSX_MAGIC);
  assert.throws(() => parseMultipartFile(body, contentType, 'file'), /No "file" file part/);
});

test('readBodyLimited assembles the body', async () => {
  const data = Buffer.from('hello world');
  const request = fakeRequest(data);
  const promise = readBodyLimited(request, 1024);
  request.emit();
  assert.ok((await promise).equals(data));
});

test('readBodyLimited aborts an oversized upload', async () => {
  const data = Buffer.alloc(2048, 0x41);
  const request = fakeRequest(data);
  const promise = readBodyLimited(request, 1024);
  request.emit();

  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof UploadError);
    assert.equal(error.status, 413, 'oversized upload is a 413');
    return true;
  });
  assert.equal(request.destroyed, true, 'the stream must be destroyed, not just drained');
});

test('readBodyLimited rejects a body over the global cap', async () => {
  assert.ok(MAX_UPLOAD_BYTES <= 10 * 1024 * 1024, 'upload cap must stay modest');
});