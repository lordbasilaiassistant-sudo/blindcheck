#!/usr/bin/env node
// blindcheck CLI — point it at a config that default-exports an array of defineGate() results.
//
//   blindcheck [path/to/blindcheck.config.mjs] [--verbose] [--json]
//
// Exit 0 only when every gate is SIGHTED. A blind gate is a defect, so CI should fail on it.
//
// ⚠ This file is written with a real editor, never through a shell heredoc. Version 0.1.0 shipped
// with `abs.replace(/\/g, '/')` because a backslash was eaten in transit, and the package was
// installable but the binary was a syntax error. The selftest imported the library directly and so
// never executed its own entry point — a test suite blind to the thing it ships, in a package about
// blind gates. test/selftest.mjs now spawns this CLI.

import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { audit, report } from '../src/index.js';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const asJson = args.includes('--json');
const file = args.find((a) => !a.startsWith('--')) || 'blindcheck.config.mjs';
const abs = path.resolve(process.cwd(), file);

if (!fs.existsSync(abs)) {
  console.error(`blindcheck: no config at ${abs}\n\nCreate one that default-exports an array of defineGate() gates.`);
  process.exit(2);
}

// pathToFileURL, not string surgery on separators — it is correct on Windows and it cannot be
// broken by whatever writes this file.
const mod = await import(pathToFileURL(abs).href);
const gates = mod.default ?? mod.gates;
if (!Array.isArray(gates)) {
  console.error(`blindcheck: ${file} must default-export an array of gates`);
  process.exit(2);
}

const result = await audit(gates);
console.log(asJson ? JSON.stringify(result, null, 2) : report(result, { verbose }));
process.exit(result.verdict === 'ALL SIGHTED' ? 0 : 1);
