import { McpError, ErrorCode } from '../lib/utils';
import { return_error, return_text_response, getBaseUrl } from '../lib/utils';
import { writesEnabled } from './handleCreateBusinessPartner';
import {
    CREATE_OBJECT_TYPES, adtErrorMessage, resolveObject, assertLocalObject, assertLocalFunctionGroup, deleteObject,
} from './handleCreateObject';

// Universal ADT delete: lock -> DELETE. Only objects in local $ packages are
// deleted; packages must be local ($...) and empty, which SAP enforces itself.

export const DELETE_OBJECT_TYPES = CREATE_OBJECT_TYPES;

export async function removeObject(args: any): Promise<Record<string, unknown>> {
    const { kind, name, objectUri } = resolveObject(args, DELETE_OBJECT_TYPES);
    const baseUrl = await getBaseUrl();
    // A local package name ($...) is already checked by resolveObject.
    if (kind.adtType === 'FUGR/FF') {
        await assertLocalFunctionGroup(baseUrl, args.function_group);
    } else if (kind.adtType !== 'DEVC/K') {
        await assertLocalObject(baseUrl, objectUri, `${args.object_type} ${name}`);
    }
    await deleteObject(baseUrl, objectUri);
    return { deleted: true, object_type: args.object_type, name, uri: objectUri };
}

export async function handleDeleteObject(args: any) {
    try {
        if (!writesEnabled()) {
            throw new McpError(ErrorCode.InvalidParams, 'Write tools are disabled; set SAP_ALLOW_WRITES=1 to enable them');
        }
        return return_text_response(JSON.stringify(await removeObject(args), null, 2));
    } catch (error) {
        return return_error(error instanceof McpError || !(error as any)?.response
            ? error
            : new McpError(ErrorCode.InternalError, adtErrorMessage(error)));
    }
}
