import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEvidencePlaywright, evidenceFor, type EvidenceOptions } from "../src/index.js";
import { EvidenceReader } from "testar-evidence/node";

export const html = `<!doctype html><html><head><title>Application form</title></head><body>
<label>Name<input id="name" value="" title="Customer name"></label>
<label>Password<input id="password" type="password" value=""></label>
<button id="apply" onclick="document.querySelector('#status').textContent='Submitted'">Apply</button>
<button id="unused">Another action</button>
<p id="status">Ready</p>
<img id="help" alt="Help image">
<div id="hidden" style="display:none"><span>Hidden details</span></div>
<div id="shadow"></div>
<iframe srcdoc="<button>Frame button</button>"></iframe>
<a id="popup" href="/popup" target="_blank">Open another page</a>
<script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button id="shadow-button">Shadow action</button>';</script>
</body></html>`;

export async function fixture(options: EvidenceOptions = {}) {
    const server = createServer((_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end(html);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const directory = await mkdtemp(path.join(tmpdir(), "testar-playwright-ts-"));
    const api = createEvidencePlaywright({evidencePath: directory, capture: {screenshots: false}, ...options});
    const browser = await api.chromium.launch({headless: true});
    const context = await browser.newContext();
    const page = await context.newPage();
    const recorder = await evidenceFor(page);
    const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    return {
        page, browser, context, recorder, url, directory,
        async close() {
            try {
                await browser.close();
            } finally {
                server.close();
                await once(server, "close");
            }
        },
        async read() {
            await recorder.finish();
            return EvidenceReader.read(recorder.directory);
        },
    };
}
