#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MongoClient, type Document, type IndexSpecification } from "mongodb";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const uri = process.env.MONGODB_URI;

if (!uri) {
  console.error("MONGODB_URI is required.");
  process.exit(1);
}

const defaultDatabase = process.env.MONGODB_DEFAULT_DB;
const readOnly = process.env.MONGODB_MCP_READ_ONLY !== "false";
const maxLimit = parsePositiveInteger(process.env.MONGODB_MCP_MAX_LIMIT, 100);
const transportMode = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();

const client = new MongoClient(uri, {
  appName: "mongodb-mcp"
});

const databaseSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Database name. Uses MONGODB_DEFAULT_DB when omitted.");

const collectionSchema = z.string().min(1).describe("Collection name.");
const documentSchema = z.record(z.unknown()).default({});

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function requireDatabase(database?: string): string {
  const name = database ?? defaultDatabase;

  if (!name) {
    throw new Error("A database must be provided or MONGODB_DEFAULT_DB must be set.");
  }

  return name;
}

function getCollection(database: string | undefined, collection: string) {
  return client.db(requireDatabase(database)).collection(collection);
}

function asJson(value: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ],
    structuredContent: value
  };
}

function assertWritable() {
  if (readOnly) {
    throw new Error("This server is running in read-only mode. Set MONGODB_MCP_READ_ONLY=false to enable writes.");
  }
}

function isEmptyDocument(document: Record<string, unknown>): boolean {
  return Object.keys(document).length === 0;
}

function assertBulkWriteFilter(filter: Record<string, unknown>, allowEmptyFilter: boolean) {
  if (isEmptyDocument(filter) && !allowEmptyFilter) {
    throw new Error("Empty filters affect every document. Set allowEmptyFilter=true to confirm this bulk write.");
  }
}

function assertReadOnlyAggregation(pipeline: Record<string, unknown>[]) {
  if (!readOnly) {
    return;
  }

  const writeStage = pipeline.find((stage) => "$out" in stage || "$merge" in stage);

  if (writeStage) {
    throw new Error(`Aggregation write stages are disabled in read-only mode: ${Object.keys(writeStage).join(", ")}`);
  }
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "mongodb-mcp",
    version: "0.1.0"
  });

  server.registerTool(
    "mongodb_ping",
  {
    title: "Ping MongoDB",
    description: "Verify the MongoDB connection and return server configuration flags.",
    inputSchema: {}
  },
  async () => {
    const ping = await client.db(defaultDatabase).admin().ping();
    return asJson({
      ok: ping.ok === 1,
      readOnly,
      defaultDatabase: defaultDatabase ?? null,
      maxLimit
    });
  }
);

server.registerTool(
  "mongodb_list_databases",
  {
    title: "List MongoDB databases",
    description: "List databases visible to the configured MongoDB user.",
    inputSchema: {}
  },
  async () => {
    const result = await client.db().admin().listDatabases();
    return asJson({
      databases: result.databases.map((database) => ({
        name: database.name,
        sizeOnDisk: database.sizeOnDisk,
        empty: database.empty
      }))
    });
  }
);

server.registerTool(
  "mongodb_list_collections",
  {
    title: "List MongoDB collections",
    description: "List collections for a database.",
    inputSchema: {
      database: databaseSchema
    }
  },
  async ({ database }) => {
    const collections = await client.db(requireDatabase(database)).listCollections().toArray();
    return asJson({
      database: requireDatabase(database),
      collections: collections.map((collection) => ({
        name: collection.name,
        type: collection.type
      }))
    });
  }
);

server.registerTool(
  "mongodb_collection_indexes",
  {
    title: "List collection indexes",
    description: "List indexes for a MongoDB collection.",
    inputSchema: {
      database: databaseSchema,
      collection: collectionSchema
    }
  },
  async ({ database, collection }) => {
    const indexes = await getCollection(database, collection).indexes();
    return asJson({ database: requireDatabase(database), collection, indexes });
  }
);

server.registerTool(
  "mongodb_find",
  {
    title: "Find MongoDB documents",
    description: "Find documents using filter, projection, sort, skip, and limit options.",
    inputSchema: {
      database: databaseSchema,
      collection: collectionSchema,
      filter: documentSchema.describe("MongoDB find filter."),
      projection: documentSchema.optional().describe("MongoDB projection document."),
      sort: documentSchema.optional().describe("MongoDB sort document."),
      skip: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(maxLimit).default(Math.min(25, maxLimit))
    }
  },
  async ({ database, collection, filter, projection, sort, skip, limit }) => {
    let cursor = getCollection(database, collection).find(filter as Document);

    if (projection) {
      cursor = cursor.project(projection as Document);
    }

    if (sort) {
      cursor = cursor.sort(sort as Document);
    }

    const documents = await cursor.skip(skip).limit(limit).toArray();
    return asJson({
      database: requireDatabase(database),
      collection,
      count: documents.length,
      documents
    });
  }
);

server.registerTool(
  "mongodb_aggregate",
  {
    title: "Run MongoDB aggregation",
    description: "Run an aggregation pipeline and return the resulting documents.",
    inputSchema: {
      database: databaseSchema,
      collection: collectionSchema,
      pipeline: z.array(documentSchema).describe("MongoDB aggregation pipeline."),
      limit: z.number().int().min(1).max(maxLimit).default(Math.min(25, maxLimit))
    }
  },
  async ({ database, collection, pipeline, limit }) => {
    assertReadOnlyAggregation(pipeline);

    const documents = await getCollection(database, collection)
      .aggregate(pipeline as Document[])
      .limit(limit)
      .toArray();

    return asJson({
      database: requireDatabase(database),
      collection,
      count: documents.length,
      documents
    });
  }
);

server.registerTool(
  "mongodb_count",
  {
    title: "Count MongoDB documents",
    description: "Count documents matching a filter.",
    inputSchema: {
      database: databaseSchema,
      collection: collectionSchema,
      filter: documentSchema.describe("MongoDB count filter.")
    }
  },
  async ({ database, collection, filter }) => {
    const count = await getCollection(database, collection).countDocuments(filter as Document);
    return asJson({ database: requireDatabase(database), collection, count });
  }
);

server.registerTool(
  "mongodb_insert_one",
  {
    title: "Insert one MongoDB document",
    description: "Insert one document. Requires MONGODB_MCP_READ_ONLY=false.",
    inputSchema: {
      database: databaseSchema,
      collection: collectionSchema,
      document: z.record(z.unknown()).describe("Document to insert.")
    }
  },
  async ({ database, collection, document }) => {
    assertWritable();
    const result = await getCollection(database, collection).insertOne(document as Document);
    return asJson({
      database: requireDatabase(database),
      collection,
      acknowledged: result.acknowledged,
      insertedId: result.insertedId
    });
  }
);

server.registerTool(
  "mongodb_update_many",
  {
    title: "Update MongoDB documents",
    description: "Update all documents matching a filter. Requires MONGODB_MCP_READ_ONLY=false.",
    inputSchema: {
      database: databaseSchema,
      collection: collectionSchema,
      filter: documentSchema.describe("MongoDB update filter."),
      update: z.record(z.unknown()).describe("MongoDB update document, such as { \"$set\": { ... } }."),
      upsert: z.boolean().default(false),
      allowEmptyFilter: z.boolean().default(false).describe("Set to true to confirm an update that matches every document.")
    }
  },
  async ({ database, collection, filter, update, upsert, allowEmptyFilter }) => {
    assertWritable();
    assertBulkWriteFilter(filter, allowEmptyFilter);

    const result = await getCollection(database, collection).updateMany(filter as Document, update as Document, { upsert });
    return asJson({
      database: requireDatabase(database),
      collection,
      acknowledged: result.acknowledged,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      upsertedCount: result.upsertedCount,
      upsertedId: result.upsertedId
    });
  }
);

server.registerTool(
  "mongodb_delete_many",
  {
    title: "Delete MongoDB documents",
    description: "Delete all documents matching a filter. Requires MONGODB_MCP_READ_ONLY=false.",
    inputSchema: {
      database: databaseSchema,
      collection: collectionSchema,
      filter: documentSchema.describe("MongoDB delete filter."),
      allowEmptyFilter: z.boolean().default(false).describe("Set to true to confirm a delete that matches every document.")
    }
  },
  async ({ database, collection, filter, allowEmptyFilter }) => {
    assertWritable();
    assertBulkWriteFilter(filter, allowEmptyFilter);

    const result = await getCollection(database, collection).deleteMany(filter as Document);
    return asJson({
      database: requireDatabase(database),
      collection,
      acknowledged: result.acknowledged,
      deletedCount: result.deletedCount
    });
  }
);

server.registerTool(
  "mongodb_create_index",
  {
    title: "Create MongoDB index",
    description: "Create an index on a collection. Requires MONGODB_MCP_READ_ONLY=false.",
    inputSchema: {
      database: databaseSchema,
      collection: collectionSchema,
      keys: z.record(z.union([z.literal(1), z.literal(-1), z.string()])).describe("MongoDB index keys."),
      name: z.string().optional(),
      unique: z.boolean().optional()
    }
  },
  async ({ database, collection, keys, name, unique }) => {
    assertWritable();
    const indexName = await getCollection(database, collection).createIndex(keys as IndexSpecification, {
      name,
      unique
    });

    return asJson({
      database: requireDatabase(database),
      collection,
      indexName
    });
  }
);

  return server;
}

async function runStdio() {
  await client.connect();

  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isInitializeRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }

  const value = body as { method?: unknown };
  return value.method === "initialize";
}

async function runHttp() {
  await client.connect();

  const host = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
  const port = parsePositiveInteger(process.env.MCP_HTTP_PORT ?? "3000", 3000);
  const sessions = new Map<string, SessionEntry>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const sessionId = req.headers["mcp-session-id"];
      const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

      if (existing) {
        await existing.transport.handleRequest(req, res);
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session. Send an initialize request first." }, id: null }));
        return;
      }

      const rawBody = await readRequestBody(req);
      let parsedBody: unknown;
      try {
        parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: invalid JSON." }, id: null }));
        return;
      }

      if (!isInitializeRequest(parsedBody)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid session. Send an initialize request first." }, id: null }));
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server });
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
        }
      });

      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message }, id: null }));
      } else {
        res.end();
      }
    }
  });

  httpServer.listen(port, host, () => {
    console.error(`MongoDB MCP (HTTP Streamable) listening on http://${host}:${port}/`);
  });

  return httpServer;
}

async function main() {
  if (transportMode === "http" || transportMode === "streamable-http") {
    await runHttp();
  } else if (transportMode === "stdio") {
    await runStdio();
  } else {
    console.error(`Unknown MCP_TRANSPORT value "${transportMode}". Use "stdio" or "http".`);
    process.exit(1);
  }
}

process.on("SIGINT", async () => {
  await client.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await client.close();
  process.exit(0);
});

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  await client.close();
  process.exit(1);
});
