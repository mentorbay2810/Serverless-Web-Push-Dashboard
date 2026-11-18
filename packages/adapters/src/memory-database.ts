import { documentPage, type Document, type DocumentDatabase, type Write } from '../../core/src/durable.js';

/** Deterministic local/test adapter; cloud correctness is separately smoke-tested. */
export class MemoryDocumentDatabase implements DocumentDatabase {
  private records = new Map<string, Document>();
  private version = 0;
  async read<T extends Document>(id: string) { return structuredClone(this.records.get(id)) as T | undefined; }
  async create(document: Document) { return this.transact([{ type: 'create', document }]); }
  async replace(document: Document, etag: string) { return this.transact([{ type: 'replace', document, etag }]); }
  async transact(operations: Write[]) {
    const next = new Map(this.records);
    for (const operation of operations) {
      const id = operation.type === 'delete' ? operation.id : operation.document.id;
      const existing = next.get(id);
      if (operation.type === 'create' ? !!existing : !existing || existing._etag !== operation.etag) return false;
      if (operation.type === 'delete') next.delete(id);
      else next.set(id, { ...structuredClone(operation.document), _etag: String(++this.version) });
    }
    this.records = next;
    return true;
  }
  async page<T extends Document>(kind: string, limit: number, cursor?: string, states?: string[]) {
    return structuredClone(documentPage<T>([...this.records.values()], kind, limit, cursor, states));
  }
}
