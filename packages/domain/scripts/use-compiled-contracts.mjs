// The compiled domain must load the compiled contracts. The package root is
// TypeScript, which Node refuses to load from a deployed node_modules.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const dist = new URL('../dist/', import.meta.url);

for (const name of readdirSync(dist)) {
  if (!/\.(?:js|d\.ts)$/.test(name)) continue;
  const file = new URL(name, dist);
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replaceAll(
      "'@daylight-saviour/contracts'",
      "'@daylight-saviour/contracts/node'",
    ),
  );
}
