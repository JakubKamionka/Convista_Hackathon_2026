import { handleUpdateBusinessPartner } from './handleUpdateBusinessPartner';
import { makeAdtRequest, getBaseUrl } from '../lib/utils';

jest.mock('../lib/utils', () => ({
  ...jest.requireActual('../lib/utils'),
  makeAdtRequest: jest.fn(),
  getBaseUrl: jest.fn(),
}));

const mockedRequest = makeAdtRequest as jest.Mock;
const url = "https://sap.example.test:44300/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner('0000001234')";

describe('handleUpdateBusinessPartner', () => {
  const originalFlag = process.env.SAP_ALLOW_WRITES;

  beforeEach(() => {
    mockedRequest.mockReset();
    (getBaseUrl as jest.Mock).mockReset().mockResolvedValue('https://sap.example.test:44300');
    process.env.SAP_ALLOW_WRITES = '1';
  });

  afterAll(() => {
    if (originalFlag === undefined) delete process.env.SAP_ALLOW_WRITES;
    else process.env.SAP_ALLOW_WRITES = originalFlag;
  });

  it('refuses to run unless SAP_ALLOW_WRITES=1', async () => {
    delete process.env.SAP_ALLOW_WRITES;
    const result = await handleUpdateBusinessPartner({ business_partner: '1234', fields: { LastName: 'X' } });
    expect(result.isError).toBe(true);
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it('reads the ETag, then PATCHes the padded partner with If-Match', async () => {
    mockedRequest
      .mockResolvedValueOnce({ headers: { etag: 'W/"datetimeoffset\'2026\'"' }, data: { d: {} } })
      .mockResolvedValueOnce({ status: 204, data: '' });
    const result = await handleUpdateBusinessPartner({
      business_partner: '1234',
      fields: { OrganizationBPName1: 'Muster AG', IsMarkedForArchiving: true },
    });
    expect(result.isError).toBe(false);
    expect(mockedRequest.mock.calls[0]).toEqual([url, 'GET', 30000, undefined, undefined, { Accept: 'application/json' }]);
    expect(mockedRequest.mock.calls[1]).toEqual([
      url,
      'PATCH',
      30000,
      { OrganizationBPName1: 'Muster AG', IsMarkedForArchiving: true },
      undefined,
      { 'Content-Type': 'application/json', 'Accept': 'application/json', 'If-Match': 'W/"datetimeoffset\'2026\'"' },
    ]);
    expect(JSON.parse(result.content[0].text)).toEqual({
      businessPartner: '0000001234', updated: true, fields: ['OrganizationBPName1', 'IsMarkedForArchiving'],
    });
  });

  it('falls back to the ETag from __metadata, then to *', async () => {
    mockedRequest
      .mockResolvedValueOnce({ headers: {}, data: { d: { __metadata: { etag: 'W/"meta"' } } } })
      .mockResolvedValueOnce({ data: '' })
      .mockResolvedValueOnce({ headers: {}, data: {} })
      .mockResolvedValueOnce({ data: '' });
    await handleUpdateBusinessPartner({ business_partner: '1234', fields: { LastName: 'X' } });
    await handleUpdateBusinessPartner({ business_partner: '1234', fields: { LastName: 'X' } });
    expect(mockedRequest.mock.calls[1][5]['If-Match']).toBe('W/"meta"');
    expect(mockedRequest.mock.calls[3][5]['If-Match']).toBe('*');
  });

  it('does not PATCH when the partner cannot be read', async () => {
    mockedRequest.mockRejectedValueOnce(new Error('Request failed with status code 404'));
    const result = await handleUpdateBusinessPartner({ business_partner: '1234', fields: { LastName: 'X' } });
    expect(result.isError).toBe(true);
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ fields: { LastName: 'X' } }, 'business_partner'],
    [{ business_partner: "12'34", fields: { LastName: 'X' } }, 'business_partner'],
    [{ business_partner: '1234' }, 'fields'],
    [{ business_partner: '1234', fields: {} }, 'fields'],
    [{ business_partner: '1234', fields: { to_BusinessPartnerAddress: 'x' } }, 'property name'],
    [{ business_partner: '1234', fields: { BusinessPartner: '9' } }, 'key field'],
    [{ business_partner: '1234', fields: { LastName: 5 } }, 'string or a boolean'],
  ])('rejects invalid input before any request (%#)', async (args, text) => {
    const result = await handleUpdateBusinessPartner(args);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(text);
    expect(mockedRequest).not.toHaveBeenCalled();
  });
});
