import workerpool from 'workerpool';
import { workerData } from 'worker_threads';

import type { MdxRecord } from './types.js';

const transformHtmlModulePath = workerData.transformHtmlModulePath as string;
const transformHtmlModule = await import(transformHtmlModulePath);
const transformHtml = transformHtmlModule.default as (html: string) => string;

function transformHtmlRecords(records: MdxRecord[]): MdxRecord[] {
    return records.map(record => ({
        entry: record.entry,
        paraphrase: transformHtml(record.paraphrase),
    }));
}

workerpool.worker({
    transformHtmlRecords,
});
