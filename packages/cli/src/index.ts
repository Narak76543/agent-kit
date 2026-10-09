#!/usr/bin/env node
import { runCli } from './program.js';

// Set exitCode instead of calling process.exit(): see runCli.
runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  },
);
