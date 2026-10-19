/**
 * OpenRouter mock sidecar — hermetic, offline LLM provider for E2E tests.
 *
 * Replaces live http://localhost:8080/v1 (or 127.0.0.1:9999) upstream calls
 * with a deterministic local HTTP server serving fixed OpenAI-compatible
 * chat-completion JSON. Eliminates network flakiness and API-key dependence
 * from containerized E2E suites.
 *
 * @invariants
 * - Binds to an ephemeral port (port 0) by default — no hardcoded port races.
 * - Exposes the actual bound port via .currentPort after start().
 * - Every request is captured in requestLog for deterministic assertions.
 * - Responses are fixed JSON (deterministic) unless overridden via setResponse().
 */

import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
  type IncomingHttpHeaders,
} from "node:http"
import { pathToFileURL } from "node:url"

export interface MockCompletionResponse {
  id: string
  choices: Array<{ message: { role: string; content: string } }>
}

export interface LoggedRequest {
  url: string
  method: string
  body: unknown
  headers: IncomingHttpHeaders
}

export class OpenRouterMockServer {
  private readonly port: number
  private readonly host: string
  private server: Server | null = null
  private boundPort: number | null = null
  readonly requestLog: LoggedRequest[] = []
  private response: MockCompletionResponse = {
    id: "gen-mock-12345",
    choices: [{ message: { role: "assistant", content: "Mocked OpenRouter response" } }],
  }

  constructor(port: number = 0, host: string = "127.0.0.1") {
    this.port = port
    this.host = host
  }

  /** The actual bound port (available after start()). */
  get currentPort(): number | null {
    return this.boundPort
  }

  /** Override the fixed response body returned for subsequent requests. */
  setResponse(response: MockCompletionResponse): void {
    this.response = response
  }

  /** Start listening on 127.0.0.1. Resolves with the bound port. */
  async start(): Promise<number> {
    this.server = createServer((req, res) => this.handle(req, res))
    return new Promise<number>((resolve) => {
      this.server!.listen(this.port, this.host, () => {
        const addr = this.server!.address()
        this.boundPort = typeof addr === "object" && addr ? addr.port : this.port
        resolve(this.boundPort!)
      })
    })
  }

  /** Stop listening. Idempotent. */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => {
        this.server = null
        this.boundPort = null
        resolve()
      })
    })
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    // Bound to 0.0.0.0 when run as a container sidecar so sibling containers on
    // the shared Docker network can reach it; 127.0.0.1 when used in-process.
    let body = ""
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString()
    })
    req.on("end", () => {
      let parsed: unknown = {}
      if (body) {
        try {
          parsed = JSON.parse(body)
        } catch {
          parsed = body
        }
      }
      this.requestLog.push({
        url: req.url ?? "/",
        method: req.method ?? "GET",
        body: parsed,
        headers: req.headers,
      })
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(this.response))
    })
  }
}

// ── Container entrypoint self-start ─────────────────────────────
// When this module is the Node main module (i.e. run as the sidecar container's
// command: `node --experimental-strip-types /app/sidecar.ts`), start a
// long-lived server on OPENROUTER_MOCK_PORT (default 9876) bound to 0.0.0.0 so
// sibling containers on the shared testcontainers Network can reach it via the
// `openrouter-mock` alias. When imported (e.g. by the in-process integration
// spec), this block is skipped — only the class is exported.
const isMainModule = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return false
  }
})()

if (isMainModule) {
  const port = Number(process.env.OPENROUTER_MOCK_PORT ?? "9876")
  const server = new OpenRouterMockServer(port, "0.0.0.0")
  await server.start()
  console.log(`[openrouter-mock] listening on ${port}`)
}
