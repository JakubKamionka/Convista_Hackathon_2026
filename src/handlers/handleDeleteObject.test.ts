import { handleDeleteObject } from './handleDeleteObject';
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
const localXml = '<class:abapClass><adtcore:packageRef adtcore:uri="/x" adtcore:name="$ZDEMO"/></class:abapClass>';

describe('handleDeleteObject', () => {
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
    const result = await handleDeleteObject({ object_type: 'class', name: 'ZCL_X' });
    expect(result.isError).toBe(true);
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it('checks the package, locks and deletes without unlocking', async () => {
    mockedRequest
      .mockResolvedValueOnce({ data: localXml })
      .mockResolvedValueOnce({ data: lockXml })
      .mockResolvedValueOnce({ data: '' });
    const result = await handleDeleteObject({ object_type: 'class', name: 'zcl_x' });
    expect(result.isError).toBe(false);
    const calls = mockedRequest.mock.calls;
    expect(calls.map((c) => [c[0], c[1]])).toEqual([
      [`${base}/sap/bc/adt/oo/classes/zcl_x`, 'GET'],
      [`${base}/sap/bc/adt/oo/classes/zcl_x`, 'POST'],
      [`${base}/sap/bc/adt/oo/classes/zcl_x`, 'DELETE'],
    ]);
    expect(calls[2][4]).toEqual({ lockHandle: 'H123' });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ deleted: true, name: 'ZCL_X' });
  });

  it('refuses objects outside local $ packages', async () => {
    mockedRequest.mockResolvedValueOnce({ data: '<adtcore:packageRef adtcore:name="ZPROD"/>' });
    const result = await handleDeleteObject({ object_type: 'table', name: 'ZTAB' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('ZPROD');
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it('deletes a local package without a package lookup', async () => {
    mockedRequest.mockResolvedValueOnce({ data: lockXml }).mockResolvedValueOnce({ data: '' });
    const result = await handleDeleteObject({ object_type: 'package', name: '$zdemo' });
    expect(result.isError).toBe(false);
    expect(mockedRequest.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [`${base}/sap/bc/adt/packages/%24zdemo`, 'POST'],
      [`${base}/sap/bc/adt/packages/%24zdemo`, 'DELETE'],
    ]);
  });

  it('unlocks and passes SAP exception text through when the delete fails', async () => {
    mockedRequest
      .mockResolvedValueOnce({ data: localXml })
      .mockResolvedValueOnce({ data: lockXml })
      .mockRejectedValueOnce({
        response: { status: 400, data: '<exc:exception><localizedMessage lang="EN">ZCL_X is still used</localizedMessage></exc:exception>' },
      })
      .mockResolvedValueOnce({ data: '' });
    const result = await handleDeleteObject({ object_type: 'class', name: 'ZCL_X' });
    expect(mockedRequest.mock.calls[3][4]).toEqual({ _action: 'UNLOCK', lockHandle: 'H123' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('ZCL_X is still used');
  });

  it.each([
    [{ object_type: 'transaction', name: 'ZT' }, 'object_type'],
    [{ object_type: 'program' }, 'name'],
    [{ object_type: 'program', name: 'SAPMV45A' }, 'Z or Y'],
    [{ object_type: 'package', name: '$TMP' }, '$'],
    [{ object_type: 'package', name: 'ZPKG' }, '$'],
    [{ object_type: 'function_module', name: 'Z_FM' }, 'function_group'],
  ])('rejects invalid input before any request (%#)', async (args, text) => {
    const result = await handleDeleteObject(args);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(text);
    expect(mockedRequest).not.toHaveBeenCalled();
  });
});
