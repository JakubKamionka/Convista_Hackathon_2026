import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, return_response, getBaseUrl } from '../lib/utils';

// Business partner creation goes through the released OData service, not ADT.
// The service must be activated on the target system (see /$metadata).
const BUSINESS_PARTNER_PATH = '/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner';

export function writesEnabled(): boolean {
    return process.env.SAP_ALLOW_WRITES === '1';
}

export async function handleCreateBusinessPartner(args: any) {
    try {
        if (!writesEnabled()) {
            throw new McpError(ErrorCode.InvalidParams, 'Write tools are disabled; set SAP_ALLOW_WRITES=1 to enable them');
        }
        const category = args?.business_partner_category;
        const grouping = args?.business_partner_grouping;
        if (!grouping) {
            throw new McpError(ErrorCode.InvalidParams, 'business_partner_grouping is required');
        }
        let body: Record<string, string>;
        if (category === '1') {
            if (!args.last_name) {
                throw new McpError(ErrorCode.InvalidParams, 'last_name is required for a person (category 1)');
            }
            body = {
                BusinessPartnerCategory: '1',
                BusinessPartnerGrouping: grouping,
                FirstName: args.first_name ?? '',
                LastName: args.last_name,
            };
        } else if (category === '2') {
            if (!args.organization_name) {
                throw new McpError(ErrorCode.InvalidParams, 'organization_name is required for an organization (category 2)');
            }
            body = {
                BusinessPartnerCategory: '2',
                BusinessPartnerGrouping: grouping,
                OrganizationBPName1: args.organization_name,
            };
        } else {
            throw new McpError(ErrorCode.InvalidParams, 'business_partner_category must be "1" (person) or "2" (organization)');
        }
        const url = `${await getBaseUrl()}${BUSINESS_PARTNER_PATH}`;
        const response = await makeAdtRequest(
            url,
            'POST',
            30000,
            body,
            undefined,
            { 'Content-Type': 'application/json', 'Accept': 'application/json' }
        );
        return return_response(response);
    } catch (error) {
        return return_error(error);
    }
}
