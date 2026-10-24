import { handleUpdateObject } from './handleUpdateObject';
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
const localXml = '<program:abapProgram><adtcore:packageRef adtcore:uri="/x" adtcore:name="$TMP"/></program:abapProgram>';

describe('handleUpdateObject', () => {
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
    const result = await handleUpdateObject({ object_type: 'program', name: 'ZTEST', source: 'x' });
    expect(result.isError).toBe(true);
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it('checks the package, writes source under a lock, unlocks and activates', async () => {
    mockedRequest
      .mockResolvedValueOnce({ data: localXml }) // package check
      .mockResolvedValueOnce({ data: lockXml }) // lock
      .mockResolvedValueOnce({ data: '' }) // write
      .mockResolvedValueOnce({ data: '' }) // unlock
      .mockResolvedValueOnce({ data: '' }); // activate
    const result = await handleUpdateObject({ object_type: 'program', name: 'ztest_prog', source: 'REPORT ztest_prog.' });
    expect(result.isError).toBe(false);
    const calls = mockedRequest.mock.calls;
    expect(calls.map((c) => [c[0], c[1]])).toEqual([
      [`${base}/sap/bc/adt/programs/programs/ztest_prog`, 'GET'],
      [`${base}/sap/bc/adt/programs/programs/ztest_prog`, 'POST'],
      [`${base}/sap/bc/adt/programs/programs/ztest_prog/source/main`, 'PUT'],
      [`${base}/sap/bc/adt/programs/programs/ztest_prog`, 'POST'],
      [`${base}/sap/bc/adt/activation`, 'POST'],
    ]);
    expect(calls[2][3]).toBe('REPORT ztest_prog.');
    expect(calls[2][4]).toEqual({ lockHandle: 'H123' });
    expect(calls[3][4]).toEqual({ _action: 'UNLOCK', lockHandle: 'H123' });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ updated: true, activated: true });
  });

  it('refuses objects outside local $ packages', async () => {
    mockedRequest.mockResolvedValueOnce({ data: '<adtcore:packageRef adtcore:name="ZPROD"/>' });
    const result = await handleUpdateObject({ object_type: 'class', name: 'ZCL_X', source: 'x' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('ZPROD');
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it('checks the function group for a function module', async () => {
    mockedRequest
      .mockResolvedValueOnce({ data: localXml })
      .mockResolvedValueOnce({ data: lockXml })
      .mockResolvedValueOnce({ data: '' })
      .mockResolvedValueOnce({ data: '' })
      .mockResolvedValueOnce({ data: '' });
    await handleUpdateObject({ object_type: 'function_module', name: 'Z_FM', function_group: 'ZGRP', source: 'FUNCTION z_fm.' });
    expect(mockedRequest.mock.calls[0][0]).toBe(`${base}/sap/bc/adt/functions/groups/zgrp`);
    expect(mockedRequest.mock.calls[2][0]).toBe(`${base}/sap/bc/adt/functions/groups/zgrp/fmodules/z_fm/source/main`);
  });

  it('unlocks and reports an error when writing fails', async () => {
    mockedRequest
      .mockResolvedValueOnce({ data: localXml })
      .mockResolvedValueOnce({ data: lockXml })
      .mockRejectedValueOnce({
        response: { status: 400, data: '<exc:exception><localizedMessage lang="EN">Source invalid</localizedMessage></exc:exception>' },
      })
      .mockResolvedValueOnce({ data: '' });
    const result = await handleUpdateObject({ object_type: 'interface', name: 'ZIF_X', source: 'x' });
    expect(mockedRequest.mock.calls[3][4]).toEqual({ _action: 'UNLOCK', lockHandle: 'H123' });
    expect(mockedRequest).toHaveBeenCalledTimes(4);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Source invalid');
  });

  it('reports activation errors after saving the source', async () => {
    mockedRequest
      .mockResolvedValueOnce({ data: localXml })
      .mockResolvedValueOnce({ data: lockXml })
      .mockResolvedValueOnce({ data: '' })
      .mockResolvedValueOnce({ data: '' })
      .mockResolvedValueOnce({
        data: '<chkl:messages><msg type="E" line="3"><shortText><txt>Syntax error</txt></shortText></msg></chkl:messages>',
      });
    const result = await handleUpdateObject({ object_type: 'cds_view', name: 'ZI_X', source: 'define view ...' });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      updated: true, activated: false, messages: [{ type: 'E', line: '3', text: 'Syntax error' }],
    });
  });

  it.each([
    [{ object_type: 'package', name: '$ZPKG', source: 'x' }, 'object_type'],
    [{ object_type: 'function_group', name: 'ZGRP', source: 'x' }, 'object_type'],
    [{ object_type: 'program', name: 'ZT' }, 'source'],
    [{ object_type: 'program', name: 'ATEST', source: 'x' }, 'Z or Y'],
    [{ object_type: 'function_module', name: 'Z_FM', source: 'x' }, 'function_group'],
  ])('rejects invalid input before any request (%#)', async (args, text) => {
    const result = await handleUpdateObject(args);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(text);
    expect(mockedRequest).not.toHaveBeenCalled();
  });
});
