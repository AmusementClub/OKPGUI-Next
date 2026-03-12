import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const cargoTomlPath = path.join(rootDir, 'src-tauri', 'Cargo.toml');
const tauriConfigPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');

const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
const version = packageJson.version;

if (typeof version !== 'string' || version.trim().length === 0) {
    throw new Error('package.json version must be a non-empty string');
}

const syncJsonVersion = async (filePath) => {
    const content = JSON.parse(await readFile(filePath, 'utf8'));

    if (content.version === version) {
        return false;
    }

    content.version = version;
    await writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`);
    return true;
};

const syncCargoVersion = async () => {
    const cargoToml = await readFile(cargoTomlPath, 'utf8');
    const updatedCargoToml = cargoToml.replace(
        /(\[package\][\s\S]*?\nversion = ")([^"]+)(")/,
        `$1${version}$3`
    );

    if (updatedCargoToml === cargoToml) {
        return false;
    }

    await writeFile(cargoTomlPath, updatedCargoToml);
    return true;
};

const [cargoUpdated, tauriUpdated] = await Promise.all([
    syncCargoVersion(),
    syncJsonVersion(tauriConfigPath),
]);

if (cargoUpdated || tauriUpdated) {
    console.log(`Synchronized app version to ${version}`);
}