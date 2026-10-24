import { McpError, ErrorCode } from '../lib/utils';
import { return_error, return_text_response, getBaseUrl } from '../lib/utils';
import { writesEnabled } from './handleCreateBusinessPartner';
import {
    SOURCE_OBJECT_TYPES, adtErrorMessage, resolveObject, assertLocalObject, assertLocalFunctionGroup, writeSource, activate,
} from './handleCreateObject';

// Universal ADT update: lock -> overwrite source -> unlock -> activate.
// Only objects in local $ packages are touched, so no transport is ever needed.

export const UPDATE_OBJECT_TYPES = SOURCE_OBJECT_TYPES;

// Throws while nothing was changed (invalid input, non-local object, failed
// write); once the source is written, a failed activation is reported instead.
export async function updateObject(args: any): Promise<Record<string, unknown>> {
    const { kind, name, objectUri } = resolveObject(args, UPDATE_OBJECT_TYPES);
    if (typeof args.source !== 'string' || args.source.length === 0) {
        throw new McpError(ErrorCode.InvalidParams, 'source is required');
    }
    const baseUrl = await getBaseUrl();
    if (kind.adtType === 'FUGR/FF') {
        await assertLocalFunctionGroup(baseUrl, args.function_group);
    } else {
        await assertLocalObject(baseUrl, objectUri, `${args.object_type} ${name}`);
    }

    await writeSource(baseUrl, objectUri, args.source);

    const result: Record<string, unknown> = { updated: true, object_type: args.object_type, name, uri: objectUri };
    try {
        Object.assign(result, await activate(baseUrl, objectUri, name));
    } catch (error) {
        result.activated = false;
        result.error = adtErrorMessage(error);
        result.note = 'The new source was saved but activation failed; it exists as an inactive version.';
    }
    return result;
}

export async function handleUpdateObject(args: any) {
    try {
        if (!writesEnabled()) {
            throw new McpError(ErrorCode.InvalidParams, 'Write tools are disabled; set SAP_ALLOW_WRITES=1 to enable them');
        }
        return return_text_response(JSON.stringify(await updateObject(args), null, 2));
    } catch (error) {
        return return_error(error instanceof McpError || !(error as any)?.response
            ? error
            : new McpError(ErrorCode.InternalError, adtErrorMessage(error)));
    }
}
