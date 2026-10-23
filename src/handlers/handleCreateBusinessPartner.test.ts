import { handleCreateBusinessPartner } from './handleCreateBusinessPartner';
import { makeAdtRequest, getBaseUrl } from '../lib/utils';

jest.mock('../lib/utils', () => ({
  ...jest.requireActual('../lib/utils'),
  makeAdtRequest: jest.fn(),
  getBaseUrl: jest.fn(),
}));

const mockedRequest = makeAdtRequest as jest.Mock;
const mockedBaseUrl = getBaseUrl as jest.Mock;

describe('handleCreateBusinessPartner', () => {
  const originalFlag = process.env.SAP_ALLOW_WRITES;

  beforeEach(() => {
    mockedRequest.mockReset();
    mockedBaseUrl.mockReset().mockResolvedValue('https://sap.example.test:44300');
    process.env.SAP_ALLOW_WRITES = '1';
  });

  afterAll(() => {
    if (originalFlag === undefined) delete process.env.SAP_ALLOW_WRITES;
    else process.env.SAP_ALLOW_WRITES = originalFlag;
  });

  it('refuses to run unless SAP_ALLOW_WRITES=1', async () => {
    delete process.env.SAP_ALLOW_WRITES;
    const result = await handleCreateBusinessPartner({
      business_partner_category: '1',
      business_partner_grouping: 'BP01',
      last_name: 'Muster',
    });
    expect(result.isError).toBe(true);
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it('POSTs a person to A_BusinessPartner', async () => {
    mockedRequest.mockResolvedValue({ data: { d: { BusinessPartner: '0000000999' } } });
    const result = await handleCreateBusinessPartner({
      business_partner_category: '1',
      business_partner_grouping: 'BP01',
      first_name: 'Anna',
      last_name: 'Muster',
    });
    expect(result.isError).toBe(false);
    expect(mockedRequest).toHaveBeenCalledWith(
      'https://sap.example.test:44300/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner',
      'POST',
      30000,
      {
        BusinessPartnerCategory: '1',
        BusinessPartnerGrouping: 'BP01',
        FirstName: 'Anna',
        LastName: 'Muster',
      },
      undefined,
      { 'Content-Type': 'application/json', 'Accept': 'application/json' }
    );
  });

  it('POSTs an organization with OrganizationBPName1', async () => {
    mockedRequest.mockResolvedValue({ data: {} });
    await handleCreateBusinessPartner({
      business_partner_category: '2',
      business_partner_grouping: 'BP02',
      organization_name: 'Muster GmbH',
    });
    expect(mockedRequest.mock.calls[0][3]).toEqual({
      BusinessPartnerCategory: '2',
      BusinessPartnerGrouping: 'BP02',
      OrganizationBPName1: 'Muster GmbH',
    });
  });

  it.each([
    [{ business_partner_category: '1', business_partner_grouping: 'BP01' }, 'last_name'],
    [{ business_partner_category: '2', business_partner_grouping: 'BP02' }, 'organization_name'],
    [{ business_partner_category: '1' }, 'business_partner_grouping'],
    [{ business_partner_category: '3', business_partner_grouping: 'BP01' }, 'business_partner_category'],
  ])('rejects invalid input before any request (%#)', async (args, field) => {
    const result = await handleCreateBusinessPartner(args);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(field);
    expect(mockedRequest).not.toHaveBeenCalled();
  });
});
