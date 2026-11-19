// Compiles the contracts with solc-js and writes ABI + bytecode for the app and tests.
import solc from 'solc';
import fs from 'node:fs';
import path from 'node:path';

const files = ['contracts/LeashVault.sol', 'contracts/test/MockUSD8.sol'];
const sources = Object.fromEntries(files.map((f) => [f, { content: fs.readFileSync(f, 'utf8') }]));

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris', // safest target for a new EVM chain (no PUSH0)
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors || []).filter((e) => e.severity === 'error');
for (const e of out.errors || []) console.log(e.formattedMessage);
if (errs.length) process.exit(1);

fs.mkdirSync('build', { recursive: true });
for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    fs.writeFileSync(
      path.join('build', `${name}.json`),
      JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2),
    );
    console.log('compiled', file, name, (c.evm.bytecode.object.length / 2) + ' bytes');
  }
}
// The web app only ships the vault artifact.
fs.mkdirSync('src/generated', { recursive: true });
fs.copyFileSync('build/LeashVault.json', 'src/generated/LeashVault.json');
