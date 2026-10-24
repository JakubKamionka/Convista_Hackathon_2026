import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, return_text_response, getBaseUrl } from '../lib/utils';
import { writesEnabled } from './handleCreateBusinessPartner';

// Business partner changes go through the released OData service (PATCH on
// A_BusinessPartner). The service offers no DELETE for business partners; a partner
// is retired by setting IsMarkedForArchiving (or blocked with BusinessPartnerIsBlocked).
const BUSINESS_PARTNER_PATH = '/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner';
const MAX_FIELDS = 50;

function validate(args: any): { id: string; fields: Record<string, string | boolean> } {
    const raw = String(args?.business_partner ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{1,10}$/.test(raw)) {
        throw new McpError(ErrorCode.InvalidParams, 'business_partner must be a business partner number (1-10 letters or digits)');
    }
    // Numeric partner numbers are stored with leading zeros.
    const id = /^\d+$/.test(raw) ? raw.padStart(10, '0') : raw;
    const fields = args?.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length === 0) {
        throw new McpError(ErrorCode.InvalidParams, 'fields must be a non-empty object of A_BusinessPartner properties to change');
    }
    const entries = Object.entries(fields);
    if (entries.length > MAX_FIELDS) {
        throw new McpError(ErrorCode.InvalidParams, `fields may change at most ${MAX_FIELDS} properties at once`);
    }
    for (const [name, value] of entries) {
        // Plain properties start upper case; navigation properties (to_...) are not allowed.
        if (!/^[A-Z][A-Za-z0-9_]{0,59}$/.test(name)) {
            throw new McpError(ErrorCode.InvalidParams, `fields.${name} is not an A_BusinessPartner property name`);
        }
        if (name === 'BusinessPartner') {
            throw new McpError(ErrorCode.InvalidParams, 'the key field BusinessPartner cannot be changed');
        }
        if (typeof value !== 'string' && typeof value !== 'boolean') {
            throw new McpError(ErrorCode.InvalidParams, `fields.${name} must be a string or a boolean`);
        }
    }
    return { id, fields };
}

export async function handleUpdateBusinessPartner(args: any) {
    try {
        if (!writesEnabled()) {
            throw new McpError(ErrorCode.InvalidParams, 'Write tools are disabled; set SAP_ALLOW_WRITES=1 to enable them');
        }
        const { id, fields } = validate(args);
        const url = `${await getBaseUrl()}${BUSINESS_PARTNER_PATH}('${id}')`;
        // The entity is ETag-protected: read the current ETag (this also fails with 404
        // for unknown partners before anything is written).
        const current = await makeAdtRequest(url, 'GET', 30000, undefined, undefined, { Accept: 'application/json' });
        const etag = current.headers?.etag ?? current.data?.d?.__metadata?.etag ?? '*';
        await makeAdtRequest(
            url,
            'PATCH',
            30000,
            fields,
            undefined,
            { 'Content-Type': 'application/json', 'Accept': 'application/json', 'If-Match': etag }
        );
        return return_text_response(JSON.stringify({ businessPartner: id, updated: true, fields: Object.keys(fields) }, null, 2));
    } catch (error) {
        return return_error(error);
    }
}
