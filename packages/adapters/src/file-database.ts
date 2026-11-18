import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { documentPage, type Document, type DocumentDatabase, type Write } from '../../core/src/durable.js';

/** Single-process durable local adapter. All access must go through this process. */
export class FileDocumentDatabase implements DocumentDatabase {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  private async records(): Promise<Document[]> {
    try {
      const data: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1
        || !('documents' in data) || !Array.isArray(data.documents)) throw new Error();
      return data.documents as Document[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('Cannot read queued local data. Existing data was preserved.');
    }
  }
  async read<T extends Document>(id: string): Promise<T | undefined> { await this.pending; return (await this.records()).find(row => row.id === id) as T | undefined; }
  async create(document: Document) { return this.transact([{ type: 'create', document }]); }
  async replace(document: Document, etag: string) { return this.transact([{ type: 'replace', document, etag }]); }
  async transact(operations: Write[]): Promise<boolean> {
    const operation = this.pending.then(async () => {
      const records = new Map((await this.records()).map(row => [row.id, row]));
      for (const write of operations) {
        const id = write.type === 'delete' ? write.id : write.document.id;
        const existing = records.get(id);
        if (write.type === 'create' ? !!existing : !existing || existing._etag !== write.etag) return false;
        if (write.type === 'delete') records.delete(id);
        else records.set(id, { ...write.document, _etag: randomUUID() });
      }
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, documents: [...records.values()] }), { mode: 0o600 });
      await rename(temporary, this.path);
      return true;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async page<T extends Document>(kind: string, limit: number, cursor?: string, states?: string[]) {
    await this.pending;
    return documentPage<T>(await this.records(), kind, limit, cursor, states);
  }
}
