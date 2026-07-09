# Integration harness — runtime + generation-time contract assertions

End-to-end integration tests that prove the collections this action generates
actually enforce their contract at run time. Unit tests (`tests/**`) prove we
emit the right pm.test scripts; this harness proves those scripts pass green
against a live server that honors the contract and fail against one that breaks
it (so the assertions are non-vacuous).

## Gate

```sh
npm run test:integration            # all lanes (needs the Postman CLI on PATH)
node integration/verify.mjs rest    # one live lane
node integration/verify.mjs --static-only
```

Exit 0 = `INTEGRATION PASS`. Requires `postman` (Postman CLI) installed
(`brew install postman-cli`; verified against 1.40.0). No Postman account,
network, or secrets — every mock runs on `127.0.0.1` on an ephemeral port.

## How a live lane works

Two live lane shapes share the same conform/break contract:

- **v2.1 lanes** (rest, graphql): a v2.1 collection whose requests use a
  `{{baseUrl}}` variable; the mock port is injected through an env file.
- **EC lanes** (soap): a bare runtime-EC collection
  (`{type:'collection',children}`, the output of `convertV2CollectionToEc`)
  whose `http-request` leaves carry absolute urls; the mock port is injected by
  rewriting every leaf url before the run. Multi-protocol collections only
  support the `cli` reporter, so the EC lane parses the CLI text summary rather
  than a JSON report.

1. **Generate.** `verify.mjs` esbuild-bundles the lane's generator
   (`lib/generate-*.mts`), which imports the action's REAL `src/` generators
   (esbuild resolves the `.js` import specifiers to their `.ts` sources) and
   writes the instrumented collection to `.work/`. This is the exact production
   instrumentation path — `buildContractIndex` + `instrumentContractCollection`
   for REST, `buildGraphQLCollection` + `instrumentGraphQLCollection` for GraphQL,
   `parseWsdl` + `buildSoapCollection` + `instrumentSoapCollection` +
   `convertV2CollectionToEc` for SOAP.
2. **Stand up a spec-honoring mock** (`lib/mock-*.mjs`) on an ephemeral port.
   Minimal but genuinely spec-honoring — real request/response cycles, not canned
   bytes. `conform` mode honors the contract; `break` mode violates it.
3. **Run through the Postman CLI** — `postman collection run <file>`. The mock
   runs in its own process because `execFileSync` blocks the Node event loop (an
   in-process server would never accept the CLI's connections).
4. **Assert.** `conform`: zero failing items (except documented known-limited).
   `break`: strictly more failures than conform — the injected violation is
   detected. Both must hold.

## Lanes

| lane | kind | transport | status |
| --- | --- | --- | --- |
| rest (OpenAPI 3.0) | live | HTTP, v2.1 collection | green — 101/101 conform; break detects status + schema violations |
| graphql | live | HTTP POST, v2.1 collection | green — 73/73 conform; break detects enum/type/non-null/subscription violations |
| soap | live | v3-EC `http-request` (url-rewrite, cli summary) | green — 67/67 conform; break detects wrong response element + soap:Body direct-child violations |
| grpc | static | v3-EC `grpc-request` (`runnableInCi:true`, leaves carry test events) | green — coverage-complete artifact; live lane blocked by CLI (see below) |
| mcp | static | v3-EC `mcp-request`/`http-request` (`runnableInCi:true`) | green — coverage-complete artifact; live lane blocked by CLI (see below) |
| asyncapi | static | v3-EC `ws-raw-message` (`runnableInCi:false`) | green — generation-time by design (no test-script slot) |

**Static lanes** build the protocol collection via `buildProtocolCollection` and
assert structural invariants of the generated artifact: one contract-instrumented
leaf per generated operation (coverage), leaves nest via `children` (EC) or
`item` (v2.1-wrapped EC). AsyncAPI is generation-time only; soap runs live;
grpc/mcp stay static until the CLI blockers below lift.

## Roadmap — remaining live lanes

Blocked on the pinned Postman CLI (1.40.0), proven by live probe:

- **gRPC** — the `grpc-request` scripts execute and assertions evaluate, but the
  CLI reports `runtime: request url is empty` for every `grpc-request` regardless
  of url shape (`host:port`, `grpc://host:port`, url descriptor): the pinned CLI
  does not bind `payload.url` to the gRPC target. When a CLI version wires the
  target through, stand up a `@grpc/grpc-js` server implementing
  `fixtures/grpc/routeguide.proto` (plaintext, ephemeral port; the fixture
  references `google.protobuf.*` without imports, so the mock loads WKT stubs into
  the same root) and drive it exactly like the SOAP EC lane.
- **MCP** — the native `mcp-request` items are pruned by the CLI (documented), and
  the generated MCP `http-request` leaves arrive as native v3-authoring EC
  (`{$schema,info,item}`), which the CLI runs with empty urls — unlike SOAP, whose
  leaves pass through `convertV2CollectionToEc` into the bare runtime-EC form the
  CLI executes. A live MCP lane needs the generated MCP collection reshaped to
  bare runtime-EC (as SOAP is) plus a JSON-RPC + SSE mock.

## CI lift

Each lane's mock is self-contained Node (`node:http`, plus `graphql` for the
GraphQL lane, both already deps). To gate PRs: `npm ci && npm run build`, install
the Postman CLI, then `npm run test:integration`. No services block required —
mocks bind `127.0.0.1` inside the job.

## Layout

```text
integration/
  verify.mjs              master gate (live + static lanes)
  fixtures/<protocol>/    per-lane spec fixtures (self-contained)
  lib/
    generate-rest.mts     OpenAPI -> instrumented v2.1 collection (imports src/)
    generate-graphql.mts  SDL -> instrumented v2.1 collection (imports src/)
    generate-soap.mts     WSDL -> instrumented bare runtime-EC collection (imports src/)
    check-static.mts      buildProtocolCollection -> structural invariants
    mock-rest.mjs         spec-honoring HTTP mock (conform | break)
    mock-graphql.mjs      graphql-js mock honoring the SDL (conform | break)
    mock-soap.mjs         spec-honoring SOAP 1.1 XML mock (conform | break)
  .work/                  generated collections, envs, CLI reports (gitignored)
```
