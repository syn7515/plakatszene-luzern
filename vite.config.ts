import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const COMPOSITION = fileURLToPath(new URL('./src/composition.json', import.meta.url));

// Lets the ?edit page save the composition straight into the project.
function compositionWriter(): Plugin {
  let written = '';
  return {
    name: 'composition-writer',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__composition', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          JSON.parse(body);
        } catch {
          res.statusCode = 400;
          res.end('invalid JSON');
          return;
        }
        written = body;
        await writeFile(COMPOSITION, body);
        res.end('ok');
      });
    },
    // The editor already shows what it just saved, so skip the reload that
    // writing the file would cause. Edits made by hand still reload.
    async hotUpdate({ file, read }) {
      if (file === COMPOSITION && (await read()) === written) return [];
    },
  };
}

export default defineConfig({ plugins: [compositionWriter()] });
