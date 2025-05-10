#!/usr/bin/env node

import { Command } from 'commander';
import packageJson from '../package.json' with { type: "json" };

const program = new Command();

program
    .name(packageJson.name)
    .version(packageJson.version)
    .description(packageJson.description);

program.parse();
