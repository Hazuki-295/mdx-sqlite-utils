import path from 'path';
import { fileURLToPath } from 'url';

import cliProgress from 'cli-progress';
import Database from 'better-sqlite3';
import workerpool from 'workerpool';

import type { MdxRecord } from './types.js';
import { ContentType } from './types.js';

import ModuleRegistry from './ModuleRegistry.js';

export const moduleRegistry = ModuleRegistry.getInstance();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class MdxDatabase {
    private static instances: Set<MdxDatabase> = new Set<MdxDatabase>();
    protected db: Database.Database;

    constructor(filename: string, options?: Database.Options) {
        this.db = new Database(filename, options);
        MdxDatabase.instances.add(this);
    }

    public static closeAll() {
        for (const instance of MdxDatabase.instances) {
            instance.close();
        }
    }

    public close() {
        this.db.close();
        MdxDatabase.instances.delete(this);
    }
}

export class SourceDatabase extends MdxDatabase {
    private totalRecordCount = 0;
    private htmlRecordCount = 0;
    private linkRecordCount = 0;

    constructor(filename: string) {
        SourceDatabase.optimize(filename);
        super(filename, { readonly: true });

        const counts = this.db.prepare(`
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN content_type = ? THEN 1 ELSE 0 END) AS html,
                SUM(CASE WHEN content_type = ? THEN 1 ELSE 0 END) AS link
            FROM mdx
        `).get(ContentType.HTML, ContentType.LINK) as { total: number; html: number; link: number };

        this.totalRecordCount = counts.total;
        this.htmlRecordCount = counts.html;
        this.linkRecordCount = counts.link;
    }

    private static optimize(filename: string) {
        // Open the database in read-write mode to allow schema modifications
        const db = new Database(filename, { fileMustExist: true });

        // Check if the 'content_type' column already exists in the 'mdx' table
        const columns = db.prepare('PRAGMA table_info(mdx)').all() as { name: string }[];
        const hasContentTypeColumn = columns.some(column => column.name === 'content_type');

        if (!hasContentTypeColumn) {
            // Add a new column 'content_type' to categorize the mdx records
            db.prepare('ALTER TABLE mdx ADD COLUMN content_type INTEGER').run();

            // Set the 'content_type' based on the 'paraphrase' field pattern
            db.prepare("UPDATE mdx SET content_type = CASE WHEN paraphrase LIKE '@@@LINK=%' THEN ? ELSE ? END").run(ContentType.LINK, ContentType.HTML);

            // Create an index on the 'content_type' column to speed up queries
            db.prepare('CREATE INDEX mdx_content_type_index ON mdx (content_type)').run();

            console.log("Optimization complete: added 'content_type' column, populated it, and created index 'mdx_content_type_index'.");
        }

        // Close the temporary connection
        db.close();
    }

    public fetchRecordsByEntries(entries: string[]): MdxRecord[] {
        const stmt = this.db.prepare('SELECT entry, paraphrase, content_type, rowid FROM mdx WHERE entry = ?');
        const results: MdxRecord[] = [];
        for (const entry of entries) {
            const records = stmt.all(entry) as MdxRecord[];
            if (records.length === 0) {
                console.warn(`No records found for entry: ${entry}`);
                continue;
            }
            results.push(...records);
        }
        return results;
    }

    public * fetchHtmlRecordsPaginated(pageSize = 10000): Generator<MdxRecord[]> {
        const stmt = this.db.prepare('SELECT entry, paraphrase, rowid FROM mdx WHERE content_type = ? AND rowid > ? ORDER BY rowid LIMIT ?');

        let lastRowId = 0;
        while (true) {
            const records = stmt.all(ContentType.HTML, lastRowId, pageSize) as MdxRecord[];
            if (records.length === 0) break;
            yield records;
            lastRowId = records[records.length - 1].rowid!;
        }
    }

    public async * traverseAndTransformHtmlRecordsInParallel(pageSize = 10000, chunkSize = 1000): AsyncGenerator<MdxRecord[]> {
        const bar = new cliProgress.SingleBar({ format: 'Processing HTML records {bar} {percentage}% | Elapsed Time: {duration_formatted} | {value}/{total}' }, cliProgress.Presets.shades_classic);
        bar.start(this.htmlRecordCount, 0);

        const workerPath = path.resolve(__dirname, './transform-html-worker.js');
        const modulePath = moduleRegistry.getModulePath('transformHtml');
        const pool = workerpool.pool(workerPath, {
            workerType: 'thread',
            workerThreadOpts: { workerData: { transformHtmlModulePath: modulePath } }
        });

        for (const records of this.fetchHtmlRecordsPaginated(pageSize)) {
            const chunks: MdxRecord[][] = [];

            for (let i = 0; i < records.length; i += chunkSize) {
                chunks.push(records.slice(i, i + chunkSize));
            }

            const results = await Promise.all(chunks.map(chunk => pool.exec('transformHtmlRecords', [chunk])));

            const transformedRecords = results.flat();
            yield transformedRecords;
            bar.increment(records.length);
        }

        bar.stop();
        await pool.terminate();
    }

    public fetchLinkRecords(): MdxRecord[] {
        const stmt = this.db.prepare('SELECT entry, paraphrase FROM mdx WHERE content_type = ? ORDER BY rowid');
        return stmt.all(ContentType.LINK) as MdxRecord[];
    }
}

export class TargetDatabase extends MdxDatabase {
    constructor(filename: string) {
        super(filename);
        this.initializeMdxTable();
    }

    public insertRecords(records: MdxRecord[]) {
        const stmt = this.db.prepare('INSERT INTO mdx (entry, paraphrase) VALUES (?, ?)');
        const transaction = this.db.transaction((records: MdxRecord[]) => {
            for (const record of records) {
                stmt.run(record.entry, record.paraphrase);
            }
        });
        transaction(records);
    }

    public deleteRecordsByEntries(entries: string[]) {
        const placeholders = entries.map(() => '?').join(', ');
        const stmt = this.db.prepare(`DELETE FROM mdx WHERE entry IN (${placeholders})`);
        stmt.run(...entries);
    }

    private initializeMdxTable() {
        this.db.prepare('DROP TABLE IF EXISTS mdx').run();
        this.db.prepare('CREATE TABLE mdx (entry TEXT NOT NULL, paraphrase TEXT NOT NULL)').run();
    }
}
