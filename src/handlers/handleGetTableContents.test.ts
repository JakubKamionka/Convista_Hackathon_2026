import * as utils from '../lib/utils';
import { buildSelect, handleGetTableContents } from './handleGetTableContents';

describe('GetTableContents query building', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps the unfiltered query when no filters are given', () => {
    expect(buildSelect({ table_name: 'but000' })).toBe('SELECT * FROM BUT000');
  });

  it('builds columns, filters and ordering', () => {
    expect(buildSelect({
      table_name: 'I_BusinessPartner',
      columns: ['BusinessPartner', 'BusinessPartnerName'],
      where: [
        { field: 'BusinessPartnerCategory', value: '2' },
        { field: 'CreationDate', op: 'GE', value: '20240101' },
        { field: 'BusinessPartnerName', op: 'LIKE', value: 'Con%' },
        { field: 'BusinessPartnerGrouping', op: 'IN', values: ['0001', '0002'] },
        { field: 'AuthorizationGroup', op: 'NE', value: 7 }
      ],
      order_by: [{ field: 'CreationDate', direction: 'DESC' }, { field: 'BusinessPartner' }]
    })).toBe(
      'SELECT BUSINESSPARTNER, BUSINESSPARTNERNAME FROM I_BUSINESSPARTNER' +
      " WHERE BUSINESSPARTNERCATEGORY = '2' AND CREATIONDATE >= '20240101'" +
      " AND BUSINESSPARTNERNAME LIKE 'Con%' AND BUSINESSPARTNERGROUPING IN ('0001', '0002')" +
      ' AND AUTHORIZATIONGROUP <> 7' +
      ' ORDER BY CREATIONDATE DESCENDING, BUSINESSPARTNER ASCENDING'
    );
  });

  it('escapes quotes so values cannot break out of the literal', () => {
    expect(buildSelect({
      table_name: 'BUT000',
      where: [{ field: 'NAME_ORG1', value: "x' OR '1' = '1" }]
    })).toBe("SELECT * FROM BUT000 WHERE NAME_ORG1 = 'x'' OR ''1'' = ''1'");
  });

  it('groups and counts per group', () => {
    expect(buildSelect({
      table_name: 'I_BusinessPartnerAddress',
      where: [{ field: 'Country', value: 'DE' }],
      group_by: ['Region'],
      count: true,
      order_by: [{ field: 'ROW_COUNT', direction: 'DESC' }]
    })).toBe(
      'SELECT REGION, COUNT(*) AS ROW_COUNT FROM I_BUSINESSPARTNERADDRESS' +
      " WHERE COUNTRY = 'DE' GROUP BY REGION ORDER BY ROW_COUNT DESCENDING"
    );
  });

  it('lists distinct values with group_by alone and a subset of columns', () => {
    expect(buildSelect({
      table_name: 'ADRC',
      columns: ['REGION'],
      group_by: ['COUNTRY', 'REGION']
    })).toBe('SELECT REGION FROM ADRC GROUP BY COUNTRY, REGION');
  });

  it('counts all matching rows without group_by', () => {
    expect(buildSelect({
      table_name: 'BUT000',
      where: [{ field: 'TYPE', value: '2' }],
      count: true
    })).toBe("SELECT COUNT(*) AS ROW_COUNT FROM BUT000 WHERE TYPE = '2'");
  });

  it.each([
    [{ columns: ['NAME; DELETE'] }],
    [{ group_by: ['REGION'], columns: ['CITY'] }],
    [{ group_by: ['REGION'], order_by: [{ field: 'CITY' }] }],
    [{ group_by: ['REGION'], order_by: [{ field: 'ROW_COUNT' }] }],
    [{ count: true, columns: ['REGION'] }],
    [{ count: 'yes' }],
    [{ group_by: ['REGION) --'] }],
    [{ columns: [] }],
    [{ where: [{ field: 'A OR 1=1', value: 'x' }] }],
    [{ where: [{ field: 'A', op: 'OR', value: 'x' }] }],
    [{ where: [{ field: 'A', op: 'IN', values: [] }] }],
    [{ where: [{ field: 'A', value: { nested: true } }] }],
    [{ where: [{ field: 'A', value: 'line\nbreak' }] }],
    [{ where: [{ field: 'A', value: 'x'.repeat(256) }] }],
    [{ order_by: [{ field: 'A', direction: 'SIDEWAYS' }] }]
  ])('rejects unsafe or malformed input %j', (extra) => {
    expect(() => buildSelect({ table_name: 'BUT000', ...extra })).toThrow(utils.McpError);
  });

  it('sends the filtered query to the data preview endpoint', async () => {
    jest.spyOn(utils, 'getBaseUrl').mockResolvedValue('https://sap.example');
    const request = jest.spyOn(utils, 'makeAdtRequest').mockResolvedValue({ data: '<row/>' } as any);

    const result = await handleGetTableContents({
      table_name: 'BUT000',
      columns: ['PARTNER'],
      where: [{ field: 'BU_GROUP', value: '0001' }],
      max_rows: 10
    });

    expect(result.isError).toBe(false);
    expect(request.mock.calls[0][3]).toBe("SELECT PARTNER FROM BUT000 WHERE BU_GROUP = '0001'");
    expect(request.mock.calls[0][4]).toEqual({ rowNumber: 10 });
  });

  it('reports invalid filters as errors without calling SAP', async () => {
    const request = jest.spyOn(utils, 'makeAdtRequest');
    const result = await handleGetTableContents({
      table_name: 'BUT000',
      where: [{ field: 'A', op: 'DROP', value: 'x' }]
    });
    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });
});
