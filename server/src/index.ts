import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { openDb } from './db';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4000);
const app = createApp(openDb(), { webDist: path.resolve(here, '../../web/dist') });

app.listen(port, () => {
  console.log(`Herdr API listening on http://localhost:${port}`);
});
