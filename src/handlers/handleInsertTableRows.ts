import { randomBytes } from 'crypto';
import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, return_text_response, getBaseUrl } from '../lib/utils';
import { writesEnabled } from './handleCreateBusinessPartner';
import { adtErrorMessage, createObject, deleteObject } from './handleCreateObject';

// Insert rows into a local customer table. ADT has no row-insert service, so this
// generates a temporary $TMP class (IF_OO_ADT_CLASSRUN) that runs one
// INSERT ... ACCEPTING DUPLICATE KEYS, runs it through ADT classrun and deletes it.
// Insert only: existing rows are skipped, never updated.

export const MAX_INSERT_ROWS = 1000;
const MAX_VALUE_LENGTH = 10_000;
// Keeps generated ABAP lines well under the 255 character limit.
const LITERAL_CHUNK = 80;

interface TableField {
    name: string;
    key: boolean;
    client: boolean;
}

function validate(args: any): { table: string; rows: Record<string, unknown>[] } {
    const table = String(args?.table_name ?? '').toUpperCase();
    if (!/^[ZY][A-Z0-9_]{0,15}$/.test(table)) {
        throw new McpError(ErrorCode.InvalidParams, 'table_name must be a Z/Y table name (max. 16 characters)');
    }
    const rows = args?.rows;
    if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_INSERT_ROWS) {
        throw new McpError(ErrorCode.InvalidParams, `rows must be an array of 1-${MAX_INSERT_ROWS} objects`);
    }
    rows.forEach((row, index) => {
        if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length === 0) {
            throw new McpError(ErrorCode.InvalidParams, `rows[${index}] must be a non-empty object of field values`);
        }
        for (const [field, value] of Object.entries(row)) {
            if (value === null) continue;
            if (typeof value === 'number' ? !Number.isFinite(value) : typeof value !== 'string') {
                throw new McpError(ErrorCode.InvalidParams, `rows[${index}].${field} must be a string, a finite number or null`);
            }
            const text = String(value);
            // Control characters cannot be expressed in a single-line ABAP literal.
            if (text.length > MAX_VALUE_LENGTH || /[\u0000-\u001f\u007f]/.test(text)) {
                throw new McpError(ErrorCode.InvalidParams, `rows[${index}].${field} is longer than ${MAX_VALUE_LENGTH} characters or contains control characters`);
            }
        }
    });
    return { table, rows };
}

// Only tables in a local $ package qualify; the DDIC object's packageRef tells.
async function assertLocalTable(baseUrl: string, table: string) {
    const response = await makeAdtRequest(`${baseUrl}/sap/bc/adt/ddic/tables/${encodeURIComponent(table.toLowerCase())}`, 'GET', 30000);
    const pkg = /<adtcore:packageRef[^>]*adtcore:name="([^"]*)"/.exec(String(response.data))?.[1];
    if (!pkg?.startsWith('$')) {
        throw new McpError(ErrorCode.InvalidParams, `table ${table} is in package ${pkg ?? 'unknown'}, not a local $ package`);
    }
}

// Reads the field list from the table's DDL source (define table ... { ... }).
export function parseTableFields(source: string): TableField[] {
    const body = /define\s+table\s+[^{]+\{([\s\S]*)\}/i.exec(source)?.[1];
    if (!body) {
        throw new McpError(ErrorCode.InvalidParams, 'could not read the table definition');
    }
    const statements = body
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, '').trim())
        .filter((line) => !line.startsWith('@'))
        .join(' ')
        .split(';')
        .map((statement) => statement.trim())
        .filter(Boolean);
    const fields: TableField[] = [];
    for (const statement of statements) {
        if (/^\.?include\b/i.test(statement)) {
            throw new McpError(ErrorCode.InvalidParams, 'tables with include structures are not supported');
        }
        const match = /^(key\s+)?([a-z0-9_/]+)\s*:\s*(\S+)/i.exec(statement);
        if (!match) {
            throw new McpError(ErrorCode.InvalidParams, `unsupported statement in table definition: ${statement.slice(0, 80)}`);
        }
        const type = match[3].toLowerCase();
        fields.push({
            name: match[2].toLowerCase(),
            key: Boolean(match[1]),
            client: Boolean(match[1]) && (type.startsWith('abap.clnt') || type === 'mandt'),
        });
    }
    return fields;
}

function checkRowsAgainstFields(rows: Record<string, unknown>[], fields: TableField[]) {
    const byName = new Map(fields.map((field) => [field.name, field]));
    const requiredKeys = fields.filter((field) => field.key && !field.client).map((field) => field.name);
    rows.forEach((row, index) => {
        const given = new Map<string, unknown>();
        for (const [name, value] of Object.entries(row)) {
            const field = byName.get(name.toLowerCase());
            if (!field) {
                throw new McpError(ErrorCode.InvalidParams, `rows[${index}]: unknown field ${name}`);
            }
            if (field.client) {
                throw new McpError(ErrorCode.InvalidParams, `rows[${index}]: the client field ${name} is filled automatically and must not be passed`);
            }
            if (given.has(field.name)) {
                throw new McpError(ErrorCode.InvalidParams, `rows[${index}]: field ${name} is given twice`);
            }
            given.set(field.name, value);
        }
        const missing = requiredKeys.filter((key) => given.get(key) == null);
        if (missing.length) {
            throw new McpError(ErrorCode.InvalidParams, `rows[${index}]: missing key field(s) ${missing.join(', ')}`);
        }
    });
}

// Backtick string literal, split into chunks joined with && to keep lines short.
export function abapLiteral(value: string): string {
    if (value === '') return '``';
    const chunks: string[] = [];
    for (let i = 0; i < value.length; i += LITERAL_CHUNK) {
        chunks.push('`' + value.slice(i, i + LITERAL_CHUNK).replace(/`/g, '``') + '`');
    }
    return chunks.join('\n        && ');
}

export function buildHelperClass(className: string, table: string, rows: Record<string, unknown>[]): string {
    const cls = className.toLowerCase();
    const tab = table.toLowerCase();
    const appends = rows.map((row) => [
        '        CLEAR row.',
        ...Object.entries(row)
            .filter(([, value]) => value !== null)
            .map(([field, value]) => `        row-${field.toLowerCase()} = ${abapLiteral(String(value))}.`),
        '        APPEND row TO rows.',
    ].join('\n'));
    return [
        `CLASS ${cls} DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
        '  PUBLIC SECTION.',
        '    INTERFACES if_oo_adt_classrun.',
        'ENDCLASS.',
        '',
        `CLASS ${cls} IMPLEMENTATION.`,
        '  METHOD if_oo_adt_classrun~main.',
        `    DATA rows TYPE STANDARD TABLE OF ${tab} WITH EMPTY KEY.`,
        `    DATA row TYPE ${tab}.`,
        '    TRY.',
        ...appends,
        `        INSERT ${tab} FROM TABLE @rows ACCEPTING DUPLICATE KEYS.`,
        '        DATA(inserted) = sy-dbcnt.',
        '        COMMIT WORK.',
        "        out->write( |MCP_RESULT inserted={ inserted } total={ lines( rows ) }| ).",
        '      CATCH cx_root INTO DATA(error).',
        '        ROLLBACK WORK.',
        "        out->write( |MCP_ERROR { error->get_text( ) }| ).",
        '    ENDTRY.',
        '  ENDMETHOD.',
        'ENDCLASS.',
        '',
    ].join('\n');
}

export async function handleInsertTableRows(args: any) {
    try {
        if (!writesEnabled()) {
            throw new McpError(ErrorCode.InvalidParams, 'Write tools are disabled; set SAP_ALLOW_WRITES=1 to enable them');
        }
        const { table, rows } = validate(args);
        const baseUrl = await getBaseUrl();
        await assertLocalTable(baseUrl, table);
        const source = await makeAdtRequest(`${baseUrl}/sap/bc/adt/ddic/tables/${encodeURIComponent(table.toLowerCase())}/source/main`, 'GET', 30000);
        checkRowsAgainstFields(rows, parseTableFields(String(source.data)));

        const className = `ZCL_MCP_INS_${randomBytes(4).toString('hex').toUpperCase()}`;
        const created = await createObject({
            object_type: 'class',
            name: className,
            description: `Temporary MCP insert helper for ${table}`,
            source: buildHelperClass(className, table, rows),
        });

        const result: Record<string, unknown> = { table, requested: rows.length, helperClass: className };
        try {
            if (created.activated !== true) {
                result.error = created.error ?? 'the generated helper class did not activate';
                result.messages = created.messages;
            } else {
                const run = await makeAdtRequest(
                    `${baseUrl}/sap/bc/adt/oo/classrun/${encodeURIComponent(className)}`,
                    'POST',
                    30000,
                    undefined,
                    undefined,
                    { Accept: 'text/plain' }
                );
                const output = String(run.data ?? '');
                const ok = /MCP_RESULT inserted=(\d+) total=(\d+)/.exec(output);
                if (ok) {
                    result.inserted = Number(ok[1]);
                    result.skippedDuplicates = Number(ok[2]) - Number(ok[1]);
                } else {
                    result.error = /MCP_ERROR (.*)/.exec(output)?.[1]?.trim() || `unexpected classrun output: ${output.slice(0, 2000)}`;
                }
            }
        } catch (error) {
            result.error = adtErrorMessage(error);
        } finally {
            try {
                await deleteObject(baseUrl, String(created.uri));
                result.helperDeleted = true;
            } catch (error) {
                result.helperDeleted = false;
                result.note = `Deleting the helper class failed (${adtErrorMessage(error)}); delete ${className} from $TMP manually.`;
            }
        }
        return return_text_response(JSON.stringify(result, null, 2));
    } catch (error) {
        return return_error(error instanceof McpError || !(error as any)?.response
            ? error
            : new McpError(ErrorCode.InternalError, adtErrorMessage(error)));
    }
}
