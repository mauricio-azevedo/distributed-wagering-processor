import { Controller, Get, Res } from '@nestjs/common';
import { readFileSync } from 'node:fs';

import { OpenEndpoint } from './open-endpoint';

/** The members this controller writes, named structurally so it imports no HTTP framework. */
interface DocumentResponse {
  setHeader(name: string, value: string): void;
  send(body: string): void;
}

/**
 * `api.contract-document`: the service serves [docs/openapi.yaml](../../../docs/openapi.yaml)
 * unchanged at `/docs-json` and renders it at `/docs`.
 *
 * Unchanged means the bytes of the repository file. Nothing here parses, re-serializes or augments
 * the document, because the point of the route is that the contract a reviewer reads, the contract
 * the DTOs implement and the contract the suites hold the code to are one artifact: a
 * re-serialization — JSON for the route's name, say — would be a second rendering of it, with its
 * own ordering, its own comments dropped and its own way of being wrong. The route keeps the
 * conventional name of the document endpoint, which is the name the contract itself declares; what
 * it carries is the YAML document, as the `Content-Type` says.
 *
 * The file is read once, at load, so a scrape of the document costs no I/O and a deployment that
 * does not carry its own contract fails at startup rather than when a reviewer asks for it.
 *
 * `/docs` is a reader for that same route and not a second copy of the contract: the page holds no
 * schema, fetches `/docs-json` in the browser, and renders whatever it finds there. The renderer is
 * pinned by version and by subresource integrity, so the page cannot change under the service it
 * documents.
 */
const DOCUMENT = readFileSync(new URL('../../../docs/openapi.yaml', import.meta.url), 'utf8');

const DOCUMENT_ROUTE = '/docs-json';

const RENDERER = 'https://cdn.jsdelivr.net/npm/redoc@2.5.0/bundles/redoc.standalone.js';

const RENDERER_INTEGRITY =
  'sha384-4vOjrBu7SuDWXcAw1qFznVLA/sKL+0l4nn+J1HY8w7cpa6twQEYuh4b0Cwuo7CyX';

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Distributed Wagering Processor HTTP API</title>
    <style>
      body {
        margin: 0;
      }
    </style>
  </head>
  <body>
    <div id="contract"></div>
    <script
      src="${RENDERER}"
      integrity="${RENDERER_INTEGRITY}"
      crossorigin="anonymous"
    ></script>
    <script>
      Redoc.init('${DOCUMENT_ROUTE}', { hideDownloadButton: false }, document.getElementById('contract'));
    </script>
  </body>
</html>
`;

@Controller()
export class ContractDocumentController {
  /** The contract document itself, byte for byte (API-011). */
  @OpenEndpoint()
  @Get('docs-json')
  document(@Res() response: DocumentResponse): void {
    response.setHeader('Content-Type', 'application/yaml; charset=utf-8');
    response.send(DOCUMENT);
  }

  /** The document rendered for a reader. */
  @OpenEndpoint()
  @Get('docs')
  page(@Res() response: DocumentResponse): void {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.send(PAGE);
  }
}
