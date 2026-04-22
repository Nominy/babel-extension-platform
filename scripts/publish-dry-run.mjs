#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const workspaces = [
  '@nominy/babel-extension-build',
  '@nominy/babel-extension-frontend',
  '@nominy/babel-babel-runtime'
];

for (const workspace of workspaces) {
  console.log(`Running npm publish --dry-run for ${workspace}`);
  if (process.platform === 'win32') {
    execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd', 'publish', '--dry-run', '--tag', 'alpha', '--workspace', workspace], {
      stdio: 'inherit'
    });
  } else {
    execFileSync('npm', ['publish', '--dry-run', '--tag', 'alpha', '--workspace', workspace], {
      stdio: 'inherit'
    });
  }
}
