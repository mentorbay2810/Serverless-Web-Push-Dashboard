import { CosmosClient, type Container, type OperationInput, type SqlParameter } from '@azure/cosmos';
import type { TokenCredential } from '@azure/core-auth';
import type { Document, DocumentDatabase, Write } from '../../core/src/durable.js';

const status = (error: unknown): number => {
  const value = error as { code?: number; statusCode?: number; cause?: unknown };
  return Number(value.code ?? value.statusCode) || (value.cause ? status(value.cause) : 0);
};
const clean = (document: Document) => {
  const { _etag: _ignored, ...body } = document;
  return JSON.parse(JSON.stringify(body));
};

export class CosmosDocumentDatabase implements DocumentDatabase {
  constructor(private readonly container: Container, private readonly siteId: string) {}
  static connect(endpoint: string, database: string, container: string, siteId: string, credential: TokenCredential) {
    const client = new CosmosClient({ endpoint, aadCredentials: credential,
      connectionPolicy: { retryOptions: { maxRetryAttemptCount: 3, maxWaitTimeInSeconds: 10 } } });
    return new CosmosDocumentDatabase(client.database(database).container(container), siteId);
  }
  async read<T extends Document>(id: string): Promise<T | undefined> {
    try { return (await this.container.item(id, this.siteId).read<T>()).resource; }
    catch (error) { if (status(error) === 404) return undefined; throw error; }
  }
  async create(document: Document): Promise<boolean> {
    try { await this.container.items.create(clean(document), { disableAutomaticIdGeneration: true }); return true; }
    catch (error) { if (status(error) === 409) return false; throw error; }
  }
  async replace(document: Document, etag: string): Promise<boolean> {
    try {
      await this.container.item(document.id, this.siteId).replace(clean(document), { accessCondition: { type: 'IfMatch', condition: etag } });
      return true;
    } catch (error) { if ([404, 409, 412].includes(status(error))) return false; throw error; }
  }
  async transact(operations: Write[]): Promise<boolean> {
    const batch: OperationInput[] = operations.flatMap<OperationInput>(operation => {
      if (operation.type === 'create') return [{ operationType: 'Create', resourceBody: clean(operation.document) }];
      if (operation.type === 'replace') return [{ operationType: 'Replace', id: operation.document.id, resourceBody: clean(operation.document), ifMatch: operation.etag }];
      // Guard the delete with a conditional patch in the same atomic batch:
      // DeleteOperationInput itself does not expose an If-Match option.
      return [
        { operationType: 'Patch', id: operation.id, ifMatch: operation.etag, resourceBody: { operations: [{ op: 'add', path: '/deleting', value: true }] } },
        { operationType: 'Delete', id: operation.id },
      ];
    });
    try {
      const response = await this.container.items.batch(batch, this.siteId);
      const codes = [response.code ?? 0, ...(response.result ?? []).map(result => result.statusCode)];
      if (codes.some(code => [404, 409, 412, 424].includes(code))) return false;
      if (response.result?.length === batch.length && codes.every(code => code >= 200 && code < 300)) return true;
      throw new Error('Cosmos transaction returned an incomplete or failed response.');
    } catch (error) { if ([404, 409, 412, 424].includes(status(error))) return false; throw error; }
  }
  async page<T extends Document>(kind: string, limit: number, cursor?: string, states?: string[]) {
    const parameters: SqlParameter[] = [{ name: '@kind', value: kind }];
    const stateQuery = states?.length ? ` AND c.state IN (${states.map((state, index) => {
      parameters.push({ name: `@state${index}`, value: state }); return `@state${index}`;
    }).join(',')})` : '';
    const response = await this.container.items.query<T>({ query: `SELECT * FROM c WHERE c.kind = @kind${stateQuery}`, parameters }, {
      partitionKey: this.siteId, maxItemCount: Math.min(100, Math.max(1, limit)), continuationToken: cursor,
    }).fetchNext();
    return { items: response.resources, ...(response.continuationToken ? { cursor: response.continuationToken } : {}) };
  }
}
