import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, return_text_response, getBaseUrl } from '../lib/utils';
import { getConfig } from '../config';
import { writesEnabled } from './handleCreateBusinessPartner';

// Universal ADT create: create -> lock -> write source -> unlock -> activate.
// Objects always go to $TMP (local, no transport). Existing objects are never
// overwritten, because the create POST fails if the name is already taken.

const PACKAGE = '$TMP';
const ADTCORE = 'http://www.sap.com/adt/core';

interface ObjectKind {
    adtType: string;
    // XML root element and its namespace declaration
    root: string;
    ns: string;
    extraAttributes?: string;
    collection: (args: any) => string;
    hasSource: boolean;
    maxNameLength?: number;
}

const KINDS: Record<string, ObjectKind> = {
    program: {
        adtType: 'PROG/P', root: 'program:abapProgram', ns: 'xmlns:program="http://www.sap.com/adt/programs/programs"',
        collection: () => '/sap/bc/adt/programs/programs', hasSource: true,
    },
    include: {
        adtType: 'PROG/I', root: 'include:abapInclude', ns: 'xmlns:include="http://www.sap.com/adt/programs/includes"',
        collection: () => '/sap/bc/adt/programs/includes', hasSource: true,
    },
    class: {
        adtType: 'CLAS/OC', root: 'class:abapClass', ns: 'xmlns:class="http://www.sap.com/adt/oo/classes"',
        extraAttributes: 'class:final="true" class:visibility="public"',
        collection: () => '/sap/bc/adt/oo/classes', hasSource: true,
    },
    interface: {
        adtType: 'INTF/OI', root: 'intf:abapInterface', ns: 'xmlns:intf="http://www.sap.com/adt/oo/interfaces"',
        collection: () => '/sap/bc/adt/oo/interfaces', hasSource: true,
    },
    function_group: {
        adtType: 'FUGR/F', root: 'group:abapFunctionGroup', ns: 'xmlns:group="http://www.sap.com/adt/functions/groups"',
        collection: () => '/sap/bc/adt/functions/groups', hasSource: false,
    },
    function_module: {
        adtType: 'FUGR/FF', root: 'fmodule:abapFunctionModule', ns: 'xmlns:fmodule="http://www.sap.com/adt/functions/fmodules"',
        collection: (args) => `/sap/bc/adt/functions/groups/${encodeURIComponent(args.function_group.toLowerCase())}/fmodules`,
        hasSource: true,
    },
    package: {
        adtType: 'DEVC/K', root: 'pak:package', ns: 'xmlns:pak="http://www.sap.com/adt/packages"',
        collection: () => '/sap/bc/adt/packages', hasSource: false,
    },
    cds_view: {
        adtType: 'DDLS/DF', root: 'ddl:ddlSource', ns: 'xmlns:ddl="http://www.sap.com/adt/ddic/ddlsources"',
        collection: () => '/sap/bc/adt/ddic/ddl/sources', hasSource: true,
    },
    behavior_definition: {
        adtType: 'BDEF/BDO', root: 'blue:blueSource', ns: 'xmlns:blue="http://www.sap.com/wbobj/blue"',
        collection: () => '/sap/bc/adt/bo/behaviordefinitions', hasSource: true,
    },
    service_definition: {
        adtType: 'SRVD/SRV', root: 'srvd:srvdSource', ns: 'xmlns:srvd="http://www.sap.com/adt/ddic/srvdsources"',
        extraAttributes: 'srvd:srvdSourceType="S"',
        collection: () => '/sap/bc/adt/ddic/srvd/sources', hasSource: true,
    },
    // Source-based DDIC (define table / define structure), needs NW 7.52+.
    table: {
        adtType: 'TABL/DT', root: 'blue:blueSource', ns: 'xmlns:blue="http://www.sap.com/wbobj/blue"',
        collection: () => '/sap/bc/adt/ddic/tables', hasSource: true, maxNameLength: 16,
    },
    structure: {
        adtType: 'TABL/DS', root: 'blue:blueSource', ns: 'xmlns:blue="http://www.sap.com/wbobj/blue"',
        collection: () => '/sap/bc/adt/ddic/structures', hasSource: true, maxNameLength: 30,
    },
};

export const CREATE_OBJECT_TYPES = Object.keys(KINDS);

// ADT errors are exc:exception XML; only its localizedMessage is passed on,
// never the raw body.
export function adtErrorMessage(error: any): string {
    const body = error?.response?.data;
    const text = typeof body === 'string' ? /<localizedMessage[^>]*>([\s\S]*?)<\/localizedMessage>/.exec(body)?.[1] : undefined;
    const status = error?.response?.status;
    if (text) return status ? `SAP request failed (HTTP ${status}): ${text}` : text;
    return error instanceof Error ? error.message : String(error);
}

function escapeXml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildCreateBody(kind: ObjectKind, args: any, name: string): string {
    const config = getConfig();
    const language = (config.language || 'EN').toUpperCase();
    const attributes = [
        kind.ns,
        `xmlns:adtcore="${ADTCORE}"`,
        `adtcore:description="${escapeXml(args.description)}"`,
        `adtcore:name="${escapeXml(name)}"`,
        `adtcore:type="${kind.adtType}"`,
        `adtcore:masterLanguage="${escapeXml(language)}"`,
        `adtcore:responsible="${escapeXml(config.username.toUpperCase())}"`,
        kind.extraAttributes,
    ].filter(Boolean).join(' ');
    let children: string;
    if (kind.adtType === 'FUGR/FF') {
        const group = args.function_group.toUpperCase();
        children = `<adtcore:containerRef adtcore:name="${escapeXml(group)}" adtcore:type="FUGR/F" adtcore:uri="/sap/bc/adt/functions/groups/${encodeURIComponent(group.toLowerCase())}"/>`;
    } else if (kind.adtType === 'DEVC/K') {
        children = `<adtcore:packageRef adtcore:name="${escapeXml(name)}"/>`
            + '<pak:attributes pak:packageType="development"/>'
            + `<pak:superPackage adtcore:name="${PACKAGE}"/>`
            + '<pak:applicationComponent/>'
            + '<pak:transport><pak:softwareComponent pak:name="LOCAL"/><pak:transportLayer pak:name=""/></pak:transport>'
            + '<pak:translation/><pak:useAccesses/><pak:packageInterfaces/><pak:subPackages/>';
    } else {
        children = `<adtcore:packageRef adtcore:name="${PACKAGE}"/>`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?><${kind.root} ${attributes}>${children}</${kind.root}>`;
}

function validate(args: any): { kind: ObjectKind; name: string } {
    const kind = KINDS[args?.object_type];
    if (!kind) {
        throw new McpError(ErrorCode.InvalidParams, `object_type must be one of: ${CREATE_OBJECT_TYPES.join(', ')}`);
    }
    if (!args.name || !args.description) {
        throw new McpError(ErrorCode.InvalidParams, 'name and description are required');
    }
    const name = String(args.name).toUpperCase();
    // Customer namespace only; local packages must start with $ so they stay non-transportable.
    const pattern = kind.adtType === 'DEVC/K' ? /^\$[A-Z0-9_]{1,29}$/ : /^[ZY][A-Z0-9_]{0,39}$/;
    if (kind.maxNameLength && name.length > kind.maxNameLength) {
        throw new McpError(ErrorCode.InvalidParams, `name must be at most ${kind.maxNameLength} characters for object_type ${args.object_type}`);
    }
    if (!pattern.test(name) || name === PACKAGE) {
        throw new McpError(
            ErrorCode.InvalidParams,
            kind.adtType === 'DEVC/K'
                ? 'package name must be a local package starting with $ (e.g. $ZDEMO)'
                : 'name must start with Z or Y and contain only A-Z, 0-9 and _'
        );
    }
    if (kind.adtType === 'FUGR/FF' && !/^[ZY][A-Z0-9_]{0,25}$/i.test(String(args.function_group ?? ''))) {
        throw new McpError(ErrorCode.InvalidParams, 'function_group (Z/Y name of an existing $TMP function group) is required for function_module');
    }
    if (args.source !== undefined && !kind.hasSource) {
        throw new McpError(ErrorCode.InvalidParams, `source is not supported for object_type ${args.object_type}`);
    }
    return { kind, name };
}

// A function module is transported with its group, so the group must be local.
async function assertLocalFunctionGroup(baseUrl: string, group: string) {
    const response = await makeAdtRequest(
        `${baseUrl}/sap/bc/adt/functions/groups/${encodeURIComponent(group.toLowerCase())}`,
        'GET',
        30000
    );
    const pkg = /<adtcore:packageRef[^>]*adtcore:name="([^"]*)"/.exec(String(response.data))?.[1];
    if (!pkg?.startsWith('$')) {
        throw new McpError(ErrorCode.InvalidParams, `function group ${group.toUpperCase()} is in package ${pkg ?? 'unknown'}, not a local $ package`);
    }
}

// Locks need a stateful ADT session; the session cookie is kept by makeAdtRequest.
const STATEFUL = { 'X-sap-adt-sessiontype': 'stateful' };

async function lockObject(baseUrl: string, objectUri: string): Promise<string> {
    const lock = await makeAdtRequest(
        `${baseUrl}${objectUri}`,
        'POST',
        30000,
        undefined,
        { _action: 'LOCK', accessMode: 'MODIFY' },
        { ...STATEFUL, Accept: 'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result' }
    );
    const lockHandle = /<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/.exec(String(lock.data))?.[1];
    if (!lockHandle) {
        throw new Error('SAP did not return a lock handle');
    }
    return lockHandle;
}

async function unlockObject(baseUrl: string, objectUri: string, lockHandle: string) {
    await makeAdtRequest(
        `${baseUrl}${objectUri}`,
        'POST',
        30000,
        undefined,
        { _action: 'UNLOCK', lockHandle },
        STATEFUL
    );
}

async function writeSource(baseUrl: string, objectUri: string, source: string) {
    const lockHandle = await lockObject(baseUrl, objectUri);
    try {
        await makeAdtRequest(
            `${baseUrl}${objectUri}/source/main`,
            'PUT',
            30000,
            source,
            { lockHandle },
            { ...STATEFUL, 'Content-Type': 'text/plain; charset=utf-8' }
        );
    } finally {
        await unlockObject(baseUrl, objectUri, lockHandle);
    }
}

// A deleted object has no lock left to release, so unlock only when the delete fails.
export async function deleteObject(baseUrl: string, objectUri: string) {
    const lockHandle = await lockObject(baseUrl, objectUri);
    try {
        await makeAdtRequest(`${baseUrl}${objectUri}`, 'DELETE', 30000, undefined, { lockHandle }, STATEFUL);
    } catch (error) {
        await unlockObject(baseUrl, objectUri, lockHandle).catch(() => undefined);
        throw error;
    }
}

async function activate(baseUrl: string, objectUri: string, name: string) {
    const body = `<?xml version="1.0" encoding="UTF-8"?><adtcore:objectReferences xmlns:adtcore="${ADTCORE}">`
        + `<adtcore:objectReference adtcore:uri="${escapeXml(objectUri)}" adtcore:name="${escapeXml(name)}"/></adtcore:objectReferences>`;
    const response = await makeAdtRequest(
        `${baseUrl}/sap/bc/adt/activation`,
        'POST',
        30000,
        body,
        { method: 'activate', preauditRequested: 'true' },
        { 'Content-Type': 'application/xml', Accept: 'application/xml' }
    );
    const xml = String(response.data ?? '');
    const messages = [...xml.matchAll(/<msg\b([^>]*)>([\s\S]*?)<\/msg>/g)].map((m) => ({
        type: /\btype="([^"]*)"/.exec(m[1])?.[1] ?? '',
        line: /\bline="([^"]*)"/.exec(m[1])?.[1],
        text: [...m[2].matchAll(/<txt>([\s\S]*?)<\/txt>/g)].map((t) => t[1]).join(' '),
    }));
    const failed = messages.some((m) => m.type === 'E' || m.type === 'A') || /<ioc:entry\b/.test(xml);
    return { activated: !failed, messages };
}

// Creates the object and reports partial progress. Throws only when nothing was
// created (invalid input or a failed create POST). Callers check SAP_ALLOW_WRITES.
export async function createObject(args: any): Promise<Record<string, unknown>> {
    const { kind, name } = validate(args);
    const baseUrl = await getBaseUrl();
    if (kind.adtType === 'FUGR/FF') {
        await assertLocalFunctionGroup(baseUrl, args.function_group);
    }
    const collection = kind.collection(args);
    const objectUri = `${collection}/${encodeURIComponent(name.toLowerCase())}`;

    await makeAdtRequest(
        `${baseUrl}${collection}`,
        'POST',
        30000,
        buildCreateBody(kind, args, name),
        undefined,
        { 'Content-Type': 'application/*' }
    );

    // From here on the object exists; report partial progress instead of hiding it.
    const result: Record<string, unknown> = {
        created: true, object_type: args.object_type, name, package: kind.adtType === 'DEVC/K' ? `${PACKAGE} (parent)` : PACKAGE, uri: objectUri,
        sourceWritten: false,
    };
    try {
        if (typeof args.source === 'string' && args.source.length > 0) {
            await writeSource(baseUrl, objectUri, args.source);
            result.sourceWritten = true;
        }
        if (kind.adtType !== 'DEVC/K') {
            Object.assign(result, await activate(baseUrl, objectUri, name));
        }
    } catch (error) {
        result.error = adtErrorMessage(error);
        result.note = 'The object was created but a later step failed; it still exists in $TMP.';
    }
    return result;
}

export async function handleCreateObject(args: any) {
    try {
        if (!writesEnabled()) {
            throw new McpError(ErrorCode.InvalidParams, 'Write tools are disabled; set SAP_ALLOW_WRITES=1 to enable them');
        }
        return return_text_response(JSON.stringify(await createObject(args), null, 2));
    } catch (error) {
        return return_error(error instanceof McpError || !(error as any)?.response
            ? error
            : new McpError(ErrorCode.InternalError, adtErrorMessage(error)));
    }
}
