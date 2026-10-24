import { handleCreateObject } from './handleCreateObject';
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

describe('handleCreateObject', () => {
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
    const result = await handleCreateObject({ object_type: 'program', name: 'ZTEST', description: 'x' });
    expect(result.isError).toBe(true);
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it('creates a program in $TMP, writes source under a lock, unlocks and activates', async () => {
    mockedRequest
      .mockResolvedValueOnce({ data: '' }) // create
      .mockResolvedValueOnce({ data: lockXml }) // lock
      .mockResolvedValueOnce({ data: '' }) // write
      .mockResolvedValueOnce({ data: '' }) // unlock
      .mockResolvedValueOnce({ data: '' }); // activate
    const result = await handleCreateObject({
      object_type: 'program', name: 'ztest_prog', description: 'Demo & <test>', source: 'REPORT ztest_prog.',
    });
    expect(result.isError).toBe(false);
    const calls = mockedRequest.mock.calls;
    expect(calls.map((c) => [c[0], c[1]])).toEqual([
      [`${base}/sap/bc/adt/programs/programs`, 'POST'],
      [`${base}/sap/bc/adt/programs/programs/ztest_prog`, 'POST'],
      [`${base}/sap/bc/adt/programs/programs/ztest_prog/source/main`, 'PUT'],
      [`${base}/sap/bc/adt/programs/programs/ztest_prog`, 'POST'],
      [`${base}/sap/bc/adt/activation`, 'POST'],
    ]);
    expect(calls[0][3]).toContain('adtcore:name="ZTEST_PROG"');
    expect(calls[0][3]).toContain('adtcore:description="Demo &amp; &lt;test&gt;"');
    expect(calls[0][3]).toContain('<adtcore:packageRef adtcore:name="$TMP"/>');
    expect(calls[1][4]).toEqual({ _action: 'LOCK', accessMode: 'MODIFY' });
    expect(calls[2][3]).toBe('REPORT ztest_prog.');
    expect(calls[2][4]).toEqual({ lockHandle: 'H123' });
    expect(calls[3][4]).toEqual({ _action: 'UNLOCK', lockHandle: 'H123' });
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({ created: true, sourceWritten: true, activated: true });
  });

  it('unlocks even when writing the source fails, and reports the object as created', async () => {
    mockedRequest
      .mockResolvedValueOnce({ data: '' })
      .mockResolvedValueOnce({ data: lockXml })
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce({ data: '' });
    const result = await handleCreateObject({ object_type: 'class', name: 'ZCL_X', description: 'x', source: 'CLASS zcl_x ...' });
    expect(mockedRequest.mock.calls[3][4]).toEqual({ _action: 'UNLOCK', lockHandle: 'H123' });
    expect(mockedRequest).toHaveBeenCalledTimes(4); // no activation after a failed write
    expect(JSON.parse(result.content[0].text)).toMatchObject({ created: true, sourceWritten: false, error: 'write failed' });
  });

  it('reports activation errors', async () => {
    mockedRequest
      .mockResolvedValueOnce({ data: '' })
      .mockResolvedValueOnce({
        data: '<chkl:messages><msg type="E" line="3"><shortText><txt>Syntax error</txt></shortText></msg></chkl:messages>',
      });
    const result = await handleCreateObject({ object_type: 'interface', name: 'ZIF_X', description: 'x' });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      activated: false, messages: [{ type: 'E', line: '3', text: 'Syntax error' }],
    });
  });

  it('passes SAP exception text through when create fails', async () => {
    mockedRequest.mockRejectedValueOnce({
      response: { status: 400, data: '<exc:exception><localizedMessage lang="EN">ZTEST already exists</localizedMessage></exc:exception>' },
    });
    const result = await handleCreateObject({ object_type: 'program', name: 'ZTEST', description: 'x' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('ZTEST already exists');
  });

  it('creates a function module only inside a local function group', async () => {
    mockedRequest.mockResolvedValueOnce({ data: '<group:abapFunctionGroup><adtcore:packageRef adtcore:name="ZPROD"/></group:abapFunctionGroup>' });
    const result = await handleCreateObject({ object_type: 'function_module', name: 'Z_FM', description: 'x', function_group: 'ZGRP' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('ZPROD');
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it('creates a local package under $TMP without activation', async () => {
    mockedRequest.mockResolvedValueOnce({ data: '' });
    const result = await handleCreateObject({ object_type: 'package', name: '$zdemo', description: 'x' });
    expect(result.isError).toBe(false);
    expect(mockedRequest).toHaveBeenCalledTimes(1);
    expect(mockedRequest.mock.calls[0][3]).toContain('<pak:superPackage adtcore:name="$TMP"/>');
    expect(mockedRequest.mock.calls[0][3]).toContain('<pak:softwareComponent pak:name="LOCAL"/>');
  });

  it.each([
    ['table', '/sap/bc/adt/ddic/tables', 'TABL/DT'],
    ['structure', '/sap/bc/adt/ddic/structures', 'TABL/DS'],
  ])('creates a %s as DDIC source and writes it', async (object_type, collection, adtType) => {
    mockedRequest
      .mockResolvedValueOnce({ data: '' })
      .mockResolvedValueOnce({ data: lockXml })
      .mockResolvedValueOnce({ data: '' })
      .mockResolvedValueOnce({ data: '' })
      .mockResolvedValueOnce({ data: '' });
    const result = await handleCreateObject({ object_type, name: 'ZDEMO', description: 'x', source: 'define ...' });
    expect(mockedRequest.mock.calls[0][0]).toBe(`${base}${collection}`);
    expect(mockedRequest.mock.calls[0][3]).toContain(`adtcore:type="${adtType}"`);
    expect(mockedRequest.mock.calls[2][0]).toBe(`${base}${collection}/zdemo/source/main`);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ created: true, sourceWritten: true, activated: true });
  });

  it.each([
    [{ object_type: 'transaction', name: 'ZT', description: 'x' }, 'object_type'],
    [{ object_type: 'table', name: 'ZTABLE_NAME_TOO_LONG', description: 'x' }, '16'],
    [{ object_type: 'program', name: 'ZT' }, 'description'],
    [{ object_type: 'program', name: 'ATEST', description: 'x' }, 'Z or Y'],
    [{ object_type: 'program', name: '/ABC/TEST', description: 'x' }, 'Z or Y'],
    [{ object_type: 'package', name: 'ZPKG', description: 'x' }, '$'],
    [{ object_type: 'package', name: '$TMP', description: 'x' }, '$'],
    [{ object_type: 'function_module', name: 'Z_FM', description: 'x' }, 'function_group'],
    [{ object_type: 'function_group', name: 'ZGRP', description: 'x', source: 'x' }, 'source'],
  ])('rejects invalid input before any request (%#)', async (args, text) => {
    const result = await handleCreateObject(args);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(text);
    expect(mockedRequest).not.toHaveBeenCalled();
  });
});
