import { changeTableRows } from './handleInsertTableRows';

// Update rows of a local customer table by key through a temporary helper report
// (see handleInsertTableRows). Rows that do not exist are reported, never inserted.
export function handleUpdateTableRows(args: any) {
    return changeTableRows('update', args);
}
