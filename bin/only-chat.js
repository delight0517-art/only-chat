#!/usr/bin/env node
/**
 * @project Only Chat (Codex Sovereign Edition)
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description Sovereign Cleanroom CLI Entry Point for Only Chat.
 */
'use strict';

const { main } = require('./codex.js');

main().catch(error => {
  console.error('Fatal:', error.message || error);
  process.exitCode = 1;
});
