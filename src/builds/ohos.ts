import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Artifact, BuildOptions, TargetArch } from "../types";
import { execCommand, retry } from "../utils";

type OhosSigningConfig = {
  certPath: string;
  storeFile: string;
  storePassword: string;
  keyAlias: string;
  keyPassword: string;
  profilePath: string;
  signAlg: string;
};

export async function installOhosBuildDependencies(): Promise<void> {
  console.log('🔧 Installing OpenHarmony build dependencies...');
  await retry(async () => {
    await execCommand('cargo', ['makepad', 'ohos', 'install-toolchain']);
  }, 3, 5000, (attempt, err) => {
    console.warn(`❌ Attempt ${attempt} to install OpenHarmony toolchain failed:`, err);
    console.log('⏳ Retrying...');
  });
  console.log('✅ OpenHarmony toolchain installed successfully.');
}

export async function buildOhosArtifacts(
  root: string,
  buildOptions: BuildOptions
): Promise<Artifact[]> {
  console.log('Building OpenHarmony artifacts...');

  const {
    target_info,
    app_version,
    main_binary_name,
    mode,
    ohos_deveco_home,
    ohos_signing_p12_base64,
    ohos_signing_profile_base64,
    ohos_signing_cert_base64,
    ohos_signing_store_password,
    ohos_signing_key_alias,
    ohos_signing_key_password,
    ohos_signing_sign_alg,
  } = buildOptions;

  if (!target_info) {
    throw new Error('Missing target info for OpenHarmony build.');
  }

  if (!main_binary_name) {
    throw new Error('Missing main binary name for OpenHarmony build.');
  }

  if (!ohos_signing_p12_base64 || !ohos_signing_profile_base64 || !ohos_signing_store_password) {
    throw new Error('OpenHarmony signing requires OHOS_P12_BASE64, OHOS_PROFILE_BASE64, and OHOS_P12_PASSWORD.');
  }

  const keyAlias = ohos_signing_key_alias ?? 'debugKey';
  const keyPassword = ohos_signing_key_password ?? ohos_signing_store_password;
  const signAlg = ohos_signing_sign_alg ?? 'SHA256withECDSA';

  const resolved_deveco_home = resolveDevecoHome(ohos_deveco_home);
  if (!resolved_deveco_home) {
    console.warn('⚠️  DEVECO_HOME not set and no DevEco installation detected. If the build fails, install DevEco Command Line Tools or set DEVECO_HOME.');
  }

  const project_name = normalizeProjectName(main_binary_name);
  const project_dir = join(root, 'target', 'makepad-open-harmony', project_name);
  const build_profile_path = join(project_dir, 'build-profile.json5');
  const signing_dir = join(project_dir, 'signing');

  const deveco_args = resolved_deveco_home ? [`--deveco-home=${resolved_deveco_home}`] : [];
  const release_args = mode === 'release' ? ['--release'] : [];

  await execCommand('cargo', [
    'makepad',
    'ohos',
    ...deveco_args,
    'deveco',
    '-p',
    main_binary_name,
    ...release_args,
  ], { cwd: root });

  const signing = await prepareSigningConfig({
    signingDir: signing_dir,
    p12Base64: ohos_signing_p12_base64,
    profileBase64: ohos_signing_profile_base64,
    certBase64: ohos_signing_cert_base64,
    storePassword: ohos_signing_store_password,
    keyAlias,
    keyPassword,
    signAlg,
  });

  updateBuildProfileSigning(build_profile_path, signing);

  await execCommand('cargo', [
    'makepad',
    'ohos',
    ...deveco_args,
    'build',
    '-p',
    main_binary_name,
    ...release_args,
  ], { cwd: root });

  const output_dir = join(project_dir, 'entry', 'build', 'outputs');
  const artifacts = collectOhosArtifacts(
    output_dir,
    mode ?? 'release',
    app_version ?? '0.0.0',
    target_info.arch,
  );

  if (artifacts.length === 0) {
    console.warn(`⚠️  No OpenHarmony artifacts found in ${output_dir}`);
  }

  return artifacts;
}

function normalizeProjectName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

function resolveDevecoHome(explicit?: string): string | undefined {
  const candidates = [
    explicit,
    process.env.DEVECO_HOME,
    process.env.OHOS_DEVECO_HOME,
    join(homedir(), 'command-line-tools'),
    join(homedir(), 'CommandLineTools'),
    join(homedir(), 'deveco'),
    '/opt/command-line-tools',
    '/opt/deveco',
    '/opt/DevEco',
    '/Applications/DevEco Studio.app/Contents',
    '/Applications/DevEcoStudio.app/Contents',
    'C:\\DevEcoStudio',
    'C:\\Program Files\\DevEco Studio',
    'C:\\Program Files (x86)\\DevEco Studio',
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function collectOhosArtifacts(
  outDir: string,
  mode: 'debug' | 'release',
  version: string,
  arch: TargetArch,
): Artifact[] {
  if (!existsSync(outDir)) {
    console.warn(`⚠️  OpenHarmony output directory not found: ${outDir}`);
    return [];
  }

  const hap_files = collectFiles(outDir).filter((file) => file.toLowerCase().endsWith('.hap'));
  return hap_files.map((file) => ({
    path: file,
    mode,
    version,
    platform: 'ohos',
    arch,
  }));
}

function collectFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full_path = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full_path));
      continue;
    }
    if (entry.isFile()) {
      results.push(full_path);
    }
  }
  return results;
}

async function prepareSigningConfig(params: {
  signingDir: string;
  p12Base64: string;
  profileBase64: string;
  certBase64?: string;
  storePassword: string;
  keyAlias: string;
  keyPassword: string;
  signAlg: string;
}): Promise<OhosSigningConfig> {
  const {
    signingDir,
    p12Base64,
    profileBase64,
    certBase64,
    storePassword,
    keyAlias,
    keyPassword,
    signAlg,
  } = params;

  mkdirSync(signingDir, { recursive: true });

  const p12_path = join(signingDir, 'ohos.p12');
  const profile_path = join(signingDir, 'ohos.p7b');
  const cert_path = join(signingDir, 'ohos.cer');

  writeFileSync(p12_path, Buffer.from(p12Base64, 'base64'));
  writeFileSync(profile_path, Buffer.from(profileBase64, 'base64'));

  if (certBase64) {
    writeFileSync(cert_path, Buffer.from(certBase64, 'base64'));
  } else {
    await extractCertFromP12(p12_path, cert_path, storePassword);
  }

  return {
    certPath: toPosixPath(cert_path),
    storeFile: toPosixPath(p12_path),
    storePassword,
    keyAlias,
    keyPassword,
    profilePath: toPosixPath(profile_path),
    signAlg,
  };
}

async function extractCertFromP12(p12Path: string, certPath: string, password: string): Promise<void> {
  try {
    await execCommand('openssl', [
      'pkcs12',
      '-in',
      p12Path,
      '-clcerts',
      '-nokeys',
      '-passin',
      `pass:${password}`,
      '-out',
      certPath,
    ]);
  } catch (error) {
    throw new Error(`Failed to extract .cer from .p12. Provide OHOS_CERT_BASE64. ${(error as Error).message}`);
  }
}

function updateBuildProfileSigning(buildProfilePath: string, signing: OhosSigningConfig): void {
  if (!existsSync(buildProfilePath)) {
    throw new Error(`OpenHarmony build-profile.json5 not found: ${buildProfilePath}`);
  }

  const content = readFileSync(buildProfilePath, 'utf8');
  const signing_block = [
    '      {',
    `        "name": ${JSON.stringify('default')},`,
    '        "type": "HarmonyOS",',
    '        "material": {',
    `          "certpath": ${JSON.stringify(signing.certPath)},`,
    `          "storePassword": ${JSON.stringify(signing.storePassword)},`,
    `          "KeyAlias": ${JSON.stringify(signing.keyAlias)},`,
    `          "KeyPassword": ${JSON.stringify(signing.keyPassword)},`,
    `          "profile": ${JSON.stringify(signing.profilePath)},`,
    `          "signAlg": ${JSON.stringify(signing.signAlg)},`,
    `          "storeFile": ${JSON.stringify(signing.storeFile)}`,
    '        }',
    '      }',
  ].join('\n');

  const replaced = content.replace(
    /("signingConfigs"\s*:\s*)\[[\s\S]*?\]/,
    `$1[\n${signing_block}\n    ]`
  );

  if (replaced === content) {
    throw new Error('Failed to update signingConfigs in build-profile.json5.');
  }

  writeFileSync(buildProfilePath, replaced);
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/');
}
