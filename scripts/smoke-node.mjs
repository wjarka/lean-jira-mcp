// Exercise the distributed bundle in an empty directory under the selected Node.
// A local Jira stub keeps PDF/image decoding and MCP startup independent of credentials.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Jimp } from 'jimp';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const deadline = setTimeout(() => {
  console.error('Node bundle smoke test timed out');
  process.exit(1);
}, 30_000);
deadline.unref();

const pdf = await PDFDocument.create();
const page = pdf.addPage();
const font = await pdf.embedFont(StandardFonts.Helvetica);
page.drawText('Node bundle PDF smoke test', { font });
const files = {
  pdf: { data: Buffer.from(await pdf.save()), mimeType: 'application/pdf', filename: 'smoke.pdf' },
  image: {
    data: await new Jimp({ width: 1600, height: 8, color: 0x3366ffff }).getBuffer('image/png'),
    mimeType: 'image/png', filename: 'smoke.png',
  },
};

const unexpected = [];
const jira = createServer((req, res) => {
  const match = req.url?.match(/^\/rest\/api\/3\/attachment\/(content\/)?(pdf|image)(?:\?.*)?$/);
  if (match) {
    const file = files[match[2]];
    if (match[1]) {
      res.writeHead(200, { 'Content-Type': file.mimeType });
      res.end(file.data);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: match[2], filename: file.filename, mimeType: file.mimeType, size: file.data.length }));
    }
  } else if (req.url === '/rest/api/3/myself') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ accountId: 'smoke-user' }));
  } else {
    unexpected.push(req.url);
    res.writeHead(404);
    res.end();
  }
});

jira.listen(0, '127.0.0.1');
await once(jira, 'listening');
const cwd = await mkdtemp(join(tmpdir(), 'lean-jira-node-'));
const entry = join(cwd, 'index.mjs');
await copyFile(new URL('../dist/index.js', import.meta.url), entry);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  cwd,
  env: {
    JIRA_BASE_URL: `http://127.0.0.1:${jira.address().port}`,
    JIRA_EMAIL: 'smoke@example.invalid',
    JIRA_API_TOKEN: 'offline-smoke-placeholder',
  },
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', (chunk) => { stderr += chunk; });
const client = new Client({ name: 'node-bundle-smoke', version: '1.0.0' });
try {
  await client.connect(transport);
  const manifest = await import('../manifest.json', { with: { type: 'json' } });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), manifest.default.tools.map((tool) => tool.name).sort());
  for (const id of ['pdf', 'image']) {
    const result = await client.callTool({ name: 'jira_read_attachment', arguments: { attachmentId: id } });
    assert.ok(!result.isError, JSON.stringify(result));
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.inlined, true, JSON.stringify(result));
    if (id === 'pdf') {
      assert.ok(result.content.some((block) => block.type === 'text' && block.text.includes('Node bundle PDF smoke test')));
    } else {
      assert.equal(envelope.downscaled, true);
      assert.ok(result.content.some((block) => block.type === 'image' && block.mimeType === 'image/png'));
    }
  }
  assert.deepEqual(unexpected, []);
  console.log(`Node ${process.versions.node}: MCP startup, tools, PDF extraction and image resizing passed`);
} catch (error) {
  console.error(stderr);
  throw error;
} finally {
  await client.close();
  jira.closeAllConnections();
  await new Promise((resolve) => jira.close(resolve));
  await rm(cwd, { recursive: true, force: true });
  clearTimeout(deadline);
}
