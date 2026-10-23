import { assertSapTarget } from './network';

const config = {
  url: 'https://sap.example.com:44300',
  username: 'u',
  password: 'p',
  client: '300',
};
const origin = config.url;

describe('assertSapTarget', () => {
  it.each([
    `${origin}/sap/bc/adt/programs/programs/ZTEST`,
    `${origin}/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner`,
  ])('allows %s', (url) => {
    expect(() => assertSapTarget(url, config)).not.toThrow();
  });

  it.each([
    `${origin}/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartnerAddress`,
    `${origin}/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner/x`,
    `${origin}/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder`,
    `${origin}/sap/bc/gui/sap/its/webgui`,
    `https://evil.example.com/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner`,
    `https://u:p@sap.example.com:44300/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner`,
    `${origin}/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner#x`,
  ])('rejects %s', (url) => {
    expect(() => assertSapTarget(url, config)).toThrow(
      'SAP request target must stay within the configured ADT origin',
    );
  });
});
