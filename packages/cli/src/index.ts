#!/usr/bin/env node
import { KIT_VERSION } from './version.js';

// Placeholder entry point; commands arrive in Phase 2.
const [arg] = process.argv.slice(2);
if (arg === '--version' || arg === '-v') {
  console.log(KIT_VERSION);
} else {
  console.log(`tossana-agents ${KIT_VERSION}\nCommands are not implemented yet.`);
}
