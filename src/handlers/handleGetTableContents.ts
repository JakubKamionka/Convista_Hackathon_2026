import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, return_response, getBaseUrl } from '../lib/utils';

// Plain table/view/field names only (namespaces like /NS/TAB are allowed)
const NAME_PATTERN = /^[A-Z0-9_/]+$/;
const COMPARISON_OPERATORS: Record<string, string> = {
    EQ: '=',
    NE: '<>',
    GT: '>',
    GE: '>=',
    LT: '<',
    LE: '<=',
    LIKE: 'LIKE',
    NOT_LIKE: 'NOT LIKE',
};
const MAX_CONDITIONS = 50;
const MAX_IN_VALUES = 500;
// ABAP text literals are limited to 255 characters
const MAX_LITERAL_LENGTH = 255;
const MAX_GROUP_FIELDS = 10;
// Alias of the COUNT(*) column; usable in order_by
export const COUNT_ALIAS = 'ROW_COUNT';

function invalid(message: string): never {
    throw new McpError(ErrorCode.InvalidParams, message);
}

function toName(value: unknown, what: string): string {
    const name = String(value ?? '').toUpperCase();
    if (!NAME_PATTERN.test(name)) {
        invalid(`Invalid ${what}: ${value}`);
    }
    return name;
}

// Values are only ever emitted as literals, never as raw SQL fragments.
function toLiteral(value: unknown, field: string): string {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) invalid(`Invalid number for ${field}: ${value}`);
        return String(value);
    }
    if (typeof value !== 'string') {
        invalid(`Value for ${field} must be a string or number`);
    }
    if (value.length > MAX_LITERAL_LENGTH || /[\x00-\x1f\x7f]/.test(value)) {
        invalid(`Invalid value for ${field}: must be at most ${MAX_LITERAL_LENGTH} printable characters`);
    }
    return `'${value.replace(/'/g, "''")}'`;
}

function buildColumns(columns: unknown): string[] | undefined {
    if (columns === undefined) return undefined;
    if (!Array.isArray(columns) || columns.length === 0) {
        invalid('columns must be a non-empty array of field names');
    }
    return columns.map((column) => toName(column, 'column name'));
}

function buildGroupBy(groupBy: unknown): string[] {
    if (groupBy === undefined) return [];
    if (!Array.isArray(groupBy) || groupBy.length > MAX_GROUP_FIELDS) {
        invalid(`group_by must be an array of at most ${MAX_GROUP_FIELDS} field names`);
    }
    return groupBy.map((field) => toName(field, 'group_by field'));
}

// Aggregation rules are checked here so the LLM gets a clear error instead of an ABAP syntax error.
function buildSelectList(args: any): { list: string; sortable?: string[] } {
    const columns = buildColumns(args.columns);
    const groupBy = buildGroupBy(args.group_by);
    if (args.count !== undefined && typeof args.count !== 'boolean') {
        invalid('count must be a boolean');
    }
    const count = args.count === true ? [`COUNT(*) AS ${COUNT_ALIAS}`] : [];
    if (groupBy.length === 0) {
        if (count.length === 0) return { list: columns?.join(', ') ?? '*' };
        if (columns) invalid('columns require group_by when count is set');
        return { list: count[0], sortable: [COUNT_ALIAS] };
    }
    const outside = columns?.filter((column) => !groupBy.includes(column)) ?? [];
    if (outside.length > 0) {
        invalid(`columns not in group_by: ${outside.join(', ')}`);
    }
    return {
        list: [...(columns ?? groupBy), ...count].join(', '),
        sortable: [...groupBy, ...(count.length ? [COUNT_ALIAS] : [])],
    };
}

function buildCondition(condition: any): string {
    const field = toName(condition?.field, 'filter field');
    const op = String(condition?.op ?? 'EQ').toUpperCase();
    if (op === 'IN') {
        const values = condition.values;
        if (!Array.isArray(values) || values.length === 0 || values.length > MAX_IN_VALUES) {
            invalid(`IN filter on ${field} needs 1-${MAX_IN_VALUES} values`);
        }
        return `${field} IN (${values.map((value: unknown) => toLiteral(value, field)).join(', ')})`;
    }
    const sqlOp = COMPARISON_OPERATORS[op];
    if (!sqlOp) {
        invalid(`Unsupported operator for ${field}: ${condition.op}`);
    }
    return `${field} ${sqlOp} ${toLiteral(condition.value, field)}`;
}

function buildWhere(where: unknown): string {
    if (where === undefined) return '';
    if (!Array.isArray(where) || where.length > MAX_CONDITIONS) {
        invalid(`where must be an array of at most ${MAX_CONDITIONS} conditions`);
    }
    if (where.length === 0) return '';
    return ` WHERE ${where.map(buildCondition).join(' AND ')}`;
}

function buildOrderBy(orderBy: unknown, sortable?: string[]): string {
    if (orderBy === undefined) return '';
    if (!Array.isArray(orderBy)) {
        invalid('order_by must be an array');
    }
    if (orderBy.length === 0) return '';
    const parts = orderBy.map((entry: any) => {
        const field = toName(entry?.field, 'order_by field');
        if (sortable && !sortable.includes(field)) {
            invalid(`order_by field ${field} must be one of: ${sortable.join(', ')}`);
        }
        const direction = String(entry?.direction ?? 'ASC').toUpperCase();
        if (direction !== 'ASC' && direction !== 'DESC') {
            invalid(`Invalid order_by direction for ${field}: ${entry.direction}`);
        }
        return `${field} ${direction === 'DESC' ? 'DESCENDING' : 'ASCENDING'}`;
    });
    return ` ORDER BY ${parts.join(', ')}`;
}

export function buildSelect(args: any): string {
    const tableName = toName(args?.table_name, 'table name');
    const { list, sortable } = buildSelectList(args);
    const groupBy = buildGroupBy(args.group_by);
    const groupClause = groupBy.length ? ` GROUP BY ${groupBy.join(', ')}` : '';
    return `SELECT ${list} FROM ${tableName}${buildWhere(args.where)}` +
        `${groupClause}${buildOrderBy(args.order_by, sortable)}`;
}

export async function handleGetTableContents(args: any) {
    try {
        if (!args?.table_name) {
            throw new McpError(ErrorCode.InvalidParams, 'Table name is required');
        }
        const query = buildSelect(args);
        const maxRows = args.max_rows || 100;
        const url = `${await getBaseUrl()}/sap/bc/adt/datapreview/freestyle`;
        const response = await makeAdtRequest(
            url,
            'POST',
            30000,
            query,
            { rowNumber: maxRows },
            { 'Content-Type': 'text/plain', 'Accept': 'application/xml, text/plain, */*' }
        );
        return return_response(response, args);
    } catch (error) {
        return return_error(error);
    }
}
