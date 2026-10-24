import { handleInsertTableRows, buildHelperReport, parseTableFields, abapLiteral } from './handleInsertTableRows';
import { handleUpdateTableRows } from './handleUpdateTableRows';
import { handleDeleteTableRows } from './handleDeleteTableRows';
import { makeAdtRequest, getBaseUrl } from '../lib/utils';

jest.mock('../lib/utils', () => ({
  ...jest.requireActual('../lib/utils'),
  makeAdtRequest: jest.fn(),
  getBaseUrl: jest.fn(),
}));
jest.mock('../config', () => ({
  getConfig: () => ({ url: 'https://sap.example.test:44300', username: 'dev', password: 'p', client: '300', language: 'en' }),
}));

const mockedRequest = makeAdtRequest as jest.Mock;
const base = 'https://sap.example.test:44300';
const lockXml = '<asx:abap><asx:values><DATA><LOCK_HANDLE>H123</LOCK_HANDLE></DATA></asx:values></asx:abap>';
const tableXml = (pkg: string) => `<blue:blueSource><adtcore:packageRef adtcore:name="${pkg}"/></blue:blueSource>`;
const tableSource = `@EndUserText.label : 'Books'
@AbapCatalog.tableCategory : #TRANSPARENT
define table zmcp_books {
  key client  : abap.clnt not null;
  key book_id : abap.numc(6) not null;
  title       : abap.char(80); // comment
  @Semantics.amount.currencyCode : 'zmcp_books.currency'
  price       : abap.curr(10,2);
  currency    : abap.cuky;
}`;

// Table checks, then CreateObject (create, lock, write, unlock, activate).
function mockUntilActivated() {
  mockedRequest
    .mockResolvedValueOnce({ data: tableXml('$TMP') })
    .mockResolvedValueOnce({ data: tableSource })
    .mockResolvedValueOnce({ data: '' })
    .mockResolvedValueOnce({ data: lockXml })
    .mockResolvedValueOnce({ data: '' })
    .mockResolvedValueOnce({ data: '' })
    .mockResolvedValueOnce({ data: '' });
}

describe('handleInsertTableRows', () => {
  const originalFlag = process.env.SAP_ALLOW_WRITES;

  beforeEach(() => {
    mockedRequest.mockReset();
    (getBaseUrl as jest.Mock).mockReset().mockResolvedValue(base);
    process.env.SAP_ALLOW_WRITES = '1';
  });

  afterAll(() => {
    if (originalFlag === undefined) delete process.env.SAP_ALLOW_WRITES;
    else process.env.SAP_ALLOW_WRITES = originalFlag;
  });

  it('refuses to run unless SAP_ALLOW_WRITES=1', async () => {
    delete process.env.SAP_ALLOW_WRITES;
    const result = await handleInsertTableRows({ table_name: 'ZMCP_BOOKS', rows: [{ book_id: '1' }] });
    expect(result.isError).toBe(true);
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it('creates a helper report, runs it, reports counts and deletes the report', async () => {
    mockUntilActivated();
    mockedRequest
      .mockResolvedValueOnce({ data: 'MCP_RESULT inserted=1 total=2\n' }) // programrun
      .mockResolvedValueOnce({ data: lockXml }) // lock for delete
      .mockResolvedValueOnce({ data: '' }); // delete
    const result = await handleInsertTableRows({
      table_name: 'zmcp_books',
      rows: [{ book_id: '000001', title: 'Clean Code', price: 34.5, currency: 'EUR' }, { BOOK_ID: '000002', title: null }],
    });
    expect(result.isError).toBe(false);
    const calls = mockedRequest.mock.calls;
    const reportName = /adtcore:name="(ZMCP_INS_[0-9A-F]{8})"/.exec(calls[2][3])![1];
    expect(calls.map((c) => [c[0], c[1]])).toEqual([
      [`${base}/sap/bc/adt/ddic/tables/zmcp_books`, 'GET'],
      [`${base}/sap/bc/adt/ddic/tables/zmcp_books/source/main`, 'GET'],
      [`${base}/sap/bc/adt/programs/programs`, 'POST'],
      [`${base}/sap/bc/adt/programs/programs/${reportName.toLowerCase()}`, 'POST'],
      [`${base}/sap/bc/adt/programs/programs/${reportName.toLowerCase()}/source/main`, 'PUT'],
      [`${base}/sap/bc/adt/programs/programs/${reportName.toLowerCase()}`, 'POST'],
      [`${base}/sap/bc/adt/activation`, 'POST'],
      [`${base}/sap/bc/adt/programs/programrun/${reportName}`, 'POST'],
      [`${base}/sap/bc/adt/programs/programs/${reportName.toLowerCase()}`, 'POST'],
      [`${base}/sap/bc/adt/programs/programs/${reportName.toLowerCase()}`, 'DELETE'],
    ]);
    expect(calls[2][3]).toContain('<adtcore:packageRef adtcore:name="$TMP"/>');
    expect(calls[4][3]).toContain('INSERT zmcp_books FROM TABLE @rows ACCEPTING DUPLICATE KEYS.');
    expect(calls[4][3]).toContain('row-price = `34.5`.');
    expect(calls[4][3]).toContain('row-book_id = `000002`.');
    expect(calls[4][3]).not.toContain('row-title = `null`');
    expect(calls[9][4]).toEqual({ lockHandle: 'H123' });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      table: 'ZMCP_BOOKS', requested: 2, inserted: 1, skippedDuplicates: 1, helperReport: reportName, helperDeleted: true,
    });
  });

  it('reports the ABAP error from the run and still deletes the helper report', async () => {
    mockUntilActivated();
    mockedRequest
      .mockResolvedValueOnce({ data: 'MCP_ERROR Unable to interpret "abc" as a number.\n' })
      .mockResolvedValueOnce({ data: lockXml })
      .mockResolvedValueOnce({ data: '' });
    const result = await handleInsertTableRows({ table_name: 'ZMCP_BOOKS', rows: [{ book_id: '1', price: 'abc' }] });
    expect(mockedRequest.mock.calls[9][1]).toBe('DELETE');
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      error: 'Unable to interpret "abc" as a number.', helperDeleted: true,
    });
  });

  it('does not run the helper when it fails to activate, and deletes it', async () => {
    mockedRequest
      .mockResolvedValueOnce({ data: tableXml('$TMP') })
      .mockResolvedValueOnce({ data: tableSource })
      .mockResolvedValueOnce({ data: '' })
      .mockResolvedValueOnce({ data: lockXml })
      .mockResolvedValueOnce({ data: '' })
      .mockResolvedValueOnce({ data: '' })
      .mockResolvedValueOnce({ data: '<msg type="E" line="9"><shortText><txt>Type error</txt></shortText></msg>' })
      .mockResolvedValueOnce({ data: lockXml })
      .mockResolvedValueOnce({ data: '' });
    const result = await handleInsertTableRows({ table_name: 'ZMCP_BOOKS', rows: [{ book_id: '1' }] });
    const calls = mockedRequest.mock.calls;
    expect(calls.some((c) => String(c[0]).includes('/programrun/'))).toBe(false);
    expect(calls[8][1]).toBe('DELETE');
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      error: 'the generated helper report did not activate', messages: [{ type: 'E', line: '9', text: 'Type error' }], helperDeleted: true,
    });
  });

  it('unlocks and reports when deleting the helper report fails', async () => {
    mockUntilActivated();
    mockedRequest
      .mockResolvedValueOnce({ data: 'MCP_RESULT inserted=1 total=1' })
      .mockResolvedValueOnce({ data: lockXml })
      .mockRejectedValueOnce(new Error('delete failed'))
      .mockResolvedValueOnce({ data: '' });
    const result = await handleInsertTableRows({ table_name: 'ZMCP_BOOKS', rows: [{ book_id: '1' }] });
    expect(mockedRequest.mock.calls[10][4]).toEqual({ _action: 'UNLOCK', lockHandle: 'H123' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({ inserted: 1, helperDeleted: false });
    expect(payload.note).toContain('delete failed');
  });

  it('refuses tables outside a local $ package before creating anything', async () => {
    mockedRequest.mockResolvedValueOnce({ data: tableXml('ZPROD') });
    const result = await handleInsertTableRows({ table_name: 'ZMCP_BOOKS', rows: [{ book_id: '1' }] });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('ZPROD');
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    [[{ isbn: '1', book_id: '1' }], 'unknown field isbn'],
    [[{ client: '100', book_id: '1' }], 'client field'],
    [[{ title: 'no key' }], 'missing key field(s) book_id'],
    [[{ book_id: '1', BOOK_ID: '2' }], 'given twice'],
  ])('checks rows against the table fields before creating anything (%#)', async (rows, text) => {
    mockedRequest.mockResolvedValueOnce({ data: tableXml('$TMP') }).mockResolvedValueOnce({ data: tableSource });
    const result = await handleInsertTableRows({ table_name: 'ZMCP_BOOKS', rows });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(text);
    expect(mockedRequest).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ table_name: 'MARA', rows: [{ a: '1' }] }, 'Z/Y'],
    [{ table_name: 'ZTABLE_NAME_TOO_LONG', rows: [{ a: '1' }] }, '16'],
    [{ table_name: 'ZT', rows: [] }, 'rows'],
    [{ table_name: 'ZT', rows: Array(1001).fill({ a: '1' }) }, 'rows'],
    [{ table_name: 'ZT', rows: [{}] }, 'non-empty'],
    [{ table_name: 'ZT', rows: [{ a: true }] }, 'string'],
    [{ table_name: 'ZT', rows: [{ a: 'line\nbreak' }] }, 'control'],
  ])('rejects invalid input before any request (%#)', async (args, text) => {
    const result = await handleInsertTableRows(args);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(text);
    expect(mockedRequest).not.toHaveBeenCalled();
  });
});

describe('helper report generation', () => {
  it('reads key, client and normal fields from DDL source', () => {
    expect(parseTableFields(tableSource)).toEqual([
      { name: 'client', key: true, client: true },
      { name: 'book_id', key: true, client: false },
      { name: 'title', key: false, client: false },
      { name: 'price', key: false, client: false },
      { name: 'currency', key: false, client: false },
    ]);
  });

  it('rejects tables with include structures', () => {
    expect(() => parseTableFields('define table zt { key mandt : mandt not null; include zstruct; }')).toThrow('include');
  });

  it('escapes backticks and splits long literals', () => {
    expect(abapLiteral('it`s')).toBe('`it``s`');
    expect(abapLiteral('')).toBe('``');
    expect(abapLiteral('x'.repeat(100))).toBe('`' + 'x'.repeat(80) + '`\n        && `' + 'x'.repeat(20) + '`');
  });

  it('keeps every generated line under the ABAP line limit', () => {
    const source = buildHelperReport('ZMCP_INS_00000000', 'ZMCP_BOOKS', [{ title: '`'.repeat(500) }]);
    expect(Math.max(...source.split('\n').map((line) => line.length))).toBeLessThan(255);
    expect(source).toContain('REPORT zmcp_ins_00000000 NO STANDARD PAGE HEADING LINE-SIZE 255.');
  });
});

describe('update and delete', () => {
  const originalFlag = process.env.SAP_ALLOW_WRITES;

  beforeEach(() => {
    mockedRequest.mockReset();
    (getBaseUrl as jest.Mock).mockReset().mockResolvedValue(base);
    process.env.SAP_ALLOW_WRITES = '1';
  });

  afterAll(() => {
    if (originalFlag === undefined) delete process.env.SAP_ALLOW_WRITES;
    else process.env.SAP_ALLOW_WRITES = originalFlag;
  });

  it('updates by key with a ZMCP_UPD helper and reports notFound', async () => {
    mockUntilActivated();
    mockedRequest
      .mockResolvedValueOnce({ data: 'MCP_RESULT updated=1 total=2\n' })
      .mockResolvedValueOnce({ data: lockXml })
      .mockResolvedValueOnce({ data: '' });
    const result = await handleUpdateTableRows({
      table_name: 'ZMCP_BOOKS',
      rows: [{ book_id: '000001', title: 'New', price: null }, { book_id: '000009', currency: 'USD' }],
    });
    const source = mockedRequest.mock.calls[4][3];
    expect(mockedRequest.mock.calls[2][3]).toMatch(/adtcore:name="ZMCP_UPD_[0-9A-F]{8}"/);
    expect(source).toContain('      UPDATE zmcp_books SET\n          title = @row-title,\n          price = @row-price\n        WHERE book_id = @row-book_id.');
    expect(source).toContain('          currency = @row-currency\n        WHERE book_id = @row-book_id.');
    expect(source).not.toContain('row-price = ');
    expect(source).not.toContain('INSERT');
    expect(JSON.parse(result.content[0].text)).toMatchObject({ table: 'ZMCP_BOOKS', requested: 2, updated: 1, notFound: 1, helperDeleted: true });
  });

  it('deletes by key with a ZMCP_DEL helper', async () => {
    mockUntilActivated();
    mockedRequest
      .mockResolvedValueOnce({ data: 'MCP_RESULT deleted=1 total=1\n' })
      .mockResolvedValueOnce({ data: lockXml })
      .mockResolvedValueOnce({ data: '' });
    const result = await handleDeleteTableRows({ table_name: 'ZMCP_BOOKS', rows: [{ book_id: '000001' }] });
    const source = mockedRequest.mock.calls[4][3];
    expect(mockedRequest.mock.calls[2][3]).toMatch(/adtcore:name="ZMCP_DEL_[0-9A-F]{8}"/);
    expect(source).toContain('DELETE zmcp_books FROM TABLE @rows.');
    expect(JSON.parse(result.content[0].text)).toMatchObject({ deleted: 1, notFound: 0, helperDeleted: true });
  });

  it('builds a multi-key WHERE clause', () => {
    const source = buildHelperReport('ZMCP_UPD_00000000', 'ZT', [{ a: '1', b: '2', c: 'x' }], 'update', ['a', 'b']);
    expect(source).toContain('        WHERE a = @row-a\n          AND b = @row-b.');
    expect(source).toContain('MCP_RESULT updated={ changed } total=1');
  });

  it.each([
    [handleUpdateTableRows, [{ book_id: '1' }], 'no non-key field'],
    [handleUpdateTableRows, [{ title: 'x' }], 'missing key field(s) book_id'],
    [handleDeleteTableRows, [{ book_id: '1', title: 'x' }], 'title is not a key field'],
    [handleDeleteTableRows, [{ book_id: null }], 'missing key field(s) book_id'],
  ])('checks rows before creating anything (%#)', async (handler, rows, text) => {
    mockedRequest.mockResolvedValueOnce({ data: tableXml('$TMP') }).mockResolvedValueOnce({ data: tableSource });
    const result = await (handler as any)({ table_name: 'ZMCP_BOOKS', rows });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(text);
    expect(mockedRequest).toHaveBeenCalledTimes(2);
  });

  it('refuses to run unless SAP_ALLOW_WRITES=1', async () => {
    delete process.env.SAP_ALLOW_WRITES;
    const result = await handleDeleteTableRows({ table_name: 'ZMCP_BOOKS', rows: [{ book_id: '1' }] });
    expect(result.isError).toBe(true);
    expect(mockedRequest).not.toHaveBeenCalled();
  });
});
