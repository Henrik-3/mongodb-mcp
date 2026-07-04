# MongoDB MCP Server

A small, packable Model Context Protocol server for MongoDB. It connects with the official MongoDB Node.js driver and exposes practical tools for inspecting databases, querying documents, running aggregations, and optionally performing writes.

It supports two transports:

- **stdio** (default) — for local MCP clients that spawn the server as a child process.
- **HTTP Streamable** — for remote or web-based clients using the MCP Streamable HTTP transport specification.

Writes are disabled by default.

## Features

- List databases and collections
- Ping the configured MongoDB deployment
- Inspect collection indexes
- Find documents with filter, projection, sort, skip, and limit
- Run aggregation pipelines
- Count documents
- Insert one document
- Update many documents
- Delete many documents
- Create indexes
- Read-only mode by default

## Install

```bash
bun install
bun run build
```

For local development:

```bash
bun run dev
```

Run with the HTTP Streamable transport:

```bash
MONGODB_URI="mongodb://localhost:27017" MCP_TRANSPORT=http bun run dev
```

For packaging:

```bash
bun pm pack
```

`npm pack` also works after `bun install` because the `prepack` script runs `bun run build`.

## Configuration

Set these environment variables in your MCP client configuration.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `MONGODB_URI` | Yes | | MongoDB connection string. |
| `MONGODB_DEFAULT_DB` | No | | Database used when a tool omits `database`. |
| `MONGODB_MCP_READ_ONLY` | No | `true` | Set to `false` to enable write tools. |
| `MONGODB_MCP_MAX_LIMIT` | No | `100` | Maximum number of documents returned by `find`. |
| `MCP_TRANSPORT` | No | `stdio` | Transport to use: `stdio` or `http`. |
| `MCP_HTTP_HOST` | No | `127.0.0.1` | Host to bind the HTTP Streamable server to. |
| `MCP_HTTP_PORT` | No | `3000` | Port for the HTTP Streamable server. |

## Transports

### stdio (default)

Spawn the server as a child process from your MCP client:

```json
{
  "mcpServers": {
    "mongodb": {
      "command": "node",
      "args": ["C:/path/to/mongodb-mcp/dist/index.js"],
      "env": {
        "MONGODB_URI": "mongodb://localhost:27017",
        "MONGODB_DEFAULT_DB": "my_database"
      }
    }
  }
}
```

### HTTP Streamable

Run the server with `MCP_TRANSPORT=http`. It exposes a single MCP endpoint at the server root (`/`) and manages sessions in-memory per `mcp-session-id`:

```bash
MONGODB_URI="mongodb://localhost:27017" \
MCP_TRANSPORT=http \
MCP_HTTP_HOST=127.0.0.1 \
MCP_HTTP_PORT=3000 \
node dist/index.js
```

Connect a Streamable HTTP MCP client to `http://127.0.0.1:3000/`.

Sessions are stateful: the server generates a session id on `initialize` and validates it on subsequent requests. Bind to `0.0.0.0` with care and place it behind an authenticated reverse proxy when exposing it remotely.

## Example Client Config

```json
{
  "mcpServers": {
    "mongodb": {
      "command": "node",
      "args": ["C:/path/to/mongodb-mcp/dist/index.js"],
      "env": {
        "MONGODB_URI": "mongodb://localhost:27017",
        "MONGODB_DEFAULT_DB": "my_database"
      }
    }
  }
}
```

After publishing, clients can run the package binary instead:

```json
{
  "mcpServers": {
    "mongodb": {
      "command": "npx",
      "args": ["-y", "@your-scope/mongodb-mcp"],
      "env": {
        "MONGODB_URI": "mongodb://localhost:27017"
      }
    }
  }
}
```

## Tools

### `mongodb_list_databases`

Lists MongoDB databases visible to the configured user.

### `mongodb_ping`

Verifies the MongoDB connection and returns basic server configuration flags.

### `mongodb_list_collections`

Lists collections for a database.

Input:

```json
{
  "database": "my_database"
}
```

### `mongodb_collection_indexes`

Lists indexes for a collection.

Input:

```json
{
  "database": "my_database",
  "collection": "users"
}
```

### `mongodb_find`

Finds documents in a collection.

Input:

```json
{
  "database": "my_database",
  "collection": "users",
  "filter": { "active": true },
  "projection": { "email": 1, "name": 1 },
  "sort": { "createdAt": -1 },
  "limit": 25
}
```

### `mongodb_aggregate`

Runs an aggregation pipeline.
In read-only mode, `$out` and `$merge` stages are blocked because they write data.

Input:

```json
{
  "database": "my_database",
  "collection": "orders",
  "pipeline": [
    { "$match": { "status": "paid" } },
    { "$group": { "_id": "$customerId", "total": { "$sum": "$amount" } } }
  ]
}
```

### `mongodb_count`

Counts documents in a collection.

Input:

```json
{
  "database": "my_database",
  "collection": "users",
  "filter": { "active": true }
}
```

### Write Tools

The following tools require `MONGODB_MCP_READ_ONLY=false`:

- `mongodb_insert_one`
- `mongodb_update_many`
- `mongodb_delete_many`
- `mongodb_create_index`

`mongodb_update_many` and `mongodb_delete_many` reject empty filters by default. Set `allowEmptyFilter: true` to confirm operations that affect every document in a collection.

## Safety

Use a MongoDB user with the least privileges needed for your workflow. The server does not attempt to bypass database permissions; it only forwards operations through the configured connection.
