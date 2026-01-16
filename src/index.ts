import { Command } from 'commander';

import { registerAddCommand } from './commands/add.js';
import { registerApplyCommand } from './commands/apply.js';
import { registerAuthCommand } from './commands/auth.js';
import { registerCacheCommand } from './commands/cache.js';
import { registerCreateCommand } from './commands/create.js';
import { registerEnvCommand } from './commands/env.js';
import { registerExtractCommand } from './commands/extract.js';
import { registerInitCommand } from './commands/init.js';
import { registerInstallCommand } from './commands/install.js';
import { registerLinkCommand } from './commands/link.js';
import { registerLoginCommand } from './commands/login.js';
import { registerLogoutCommand } from './commands/logout.js';
import { registerPublishCommand } from './commands/publish.js';
import { registerRunCommand } from './commands/run.js';
import { registerToolCommand } from './commands/tool.js';
import { registerUninstallCommand } from './commands/uninstall.js';
import { registerUnlinkCommand } from './commands/unlink.js';
import { registerUnyankCommand } from './commands/unyank.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerValidateCommand } from './commands/validate.js';
import { registerWhoamiCommand } from './commands/whoami.js';
import { registerYankCommand } from './commands/yank.js';
import { createCLIContext } from './utils/context.js';
import { getCliVersion } from './utils/version.js';

function buildProgram(argv: string[]): Command {
  const program = new Command();

  program
    .name('tz')
    .description('Terrazul CLI — The AI agent package manager')
    .version(getCliVersion())
    .option('-v, --verbose', 'Enable verbose logging', false);

  // Register commands (thin orchestration only)
  registerInitCommand(program, createCLIContext);
  registerInstallCommand(program, createCLIContext);
  registerAddCommand(program, createCLIContext);
  registerUpdateCommand(program, createCLIContext);
  registerPublishCommand(program, createCLIContext);
  registerCreateCommand(program, createCLIContext);
  registerRunCommand(program, createCLIContext);
  registerYankCommand(program, createCLIContext);
  registerUnyankCommand(program, createCLIContext);
  registerUninstallCommand(program, createCLIContext);
  registerExtractCommand(program, createCLIContext);
  registerEnvCommand(program, createCLIContext);
  registerCacheCommand(program, createCLIContext);
  registerLinkCommand(program, createCLIContext);
  registerUnlinkCommand(program, createCLIContext);
  registerValidateCommand(program, createCLIContext);
  registerApplyCommand(program, createCLIContext);
  registerToolCommand(program, createCLIContext);
  // Top-level auth aliases - might remove auth top level later
  registerLoginCommand(program, createCLIContext);
  registerLogoutCommand(program, createCLIContext);
  registerWhoamiCommand(program, createCLIContext);
  registerAuthCommand(program, createCLIContext);

  program.showHelpAfterError();
  program.showSuggestionAfterError();

  program.parse(argv);
  return program;
}

function main(argv: string[]): number {
  buildProgram(argv);
  return 0;
}

// Always execute when invoked as CLI entry
const args = process.argv as unknown as string[];
const code = main(args);
// Set exit code explicitly
process.exitCode = code;

export { buildProgram, main };
