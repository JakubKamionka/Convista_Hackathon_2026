import { changeTableRows } from './handleInsertTableRows';

// Delete rows of a local customer table by key through a temporary helper report
// (see handleInsertTableRows). Only rows given by their full key are deleted.
export function handleDeleteTableRows(args: any) {
    return changeTableRows('delete', args);
}
